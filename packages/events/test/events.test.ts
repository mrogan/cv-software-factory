import { describe, expect, it } from 'vitest';
import { formatLog, parseLog } from '../src/log-format.ts';
import { PUBLIC_VIEWS, publicView, redactSecrets } from '../src/public.ts';
import { validate } from '../src/schemas.ts';
import type { NewEvent, PublicEvent } from '../src/types.ts';
import { type Catalogue, upcast } from '../src/upcast.ts';
import { EVENT_TYPES } from '../src/versions.ts';
import { gate, judgement, opened, REPORT_TEXT, signal, VISITOR_KEY } from './fixtures.ts';

const viewOf = (event: NewEvent) =>
  publicView(event.type, { summary: event.summary, payload: event.payload, artifacts: event.artifacts });

describe('validation', () => {
  it('accepts a well-formed event of each kind in the fixtures', () => {
    for (const event of [opened, signal, judgement, gate]) expect(validate(event)).toEqual({ ok: true });
  });

  it('refuses an event with the reasons', () => {
    const result = validate({ ...signal, payload: { ...signal.payload, sense: 'smell', route: 'products' } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.problems).toEqual([
      expect.stringMatching(/^payload\.sense: /),
      expect.stringMatching(/^payload\.route: a path/),
    ]);
  });

  it('refuses an unknown type, an old version and a field it does not know', () => {
    expect(validate({ ...opened, type: 'work-item.teleported' }).ok).toBe(false);
    expect(validate({ ...opened, version: 0 }).ok).toBe(false);
    expect(validate({ ...opened, payload: { ...opened.payload, colour: 'red' } }).ok).toBe(false);
    expect(validate({ ...opened, colour: 'red' }).ok).toBe(false);
  });

  it('keeps line events and work-item events apart', () => {
    const line = { ...opened, type: 'line.started', payload: { autonomy: 'supervised' } };
    expect(validate({ ...line, work_item: null })).toEqual({ ok: true });
    expect(validate(line)).toEqual({ ok: false, problems: ['line.started belongs to the line, not to a work item'] });
    expect(validate({ ...opened, work_item: null })).toEqual({
      ok: false,
      problems: ['work-item.opened needs a work item'],
    });
  });

  it('keeps spend caps on the line', () => {
    const capped = {
      ...opened,
      work_item: null,
      type: 'spend.capped',
      payload: { cap: 'day', limitUsd: 20, spentUsd: 20.01, resets: '2026-10-05T00:00:00.000Z' },
    };
    expect(validate(capped)).toEqual({ ok: true });
    expect(validate({ ...capped, type: 'spend.cleared', payload: { cap: 'day' } })).toEqual({ ok: true });
  });

  it('names the ticket a repeat joined, and only for a repeat', () => {
    const repeat = { ...judgement, payload: { ...judgement.payload, route: 'repeat', joined: '1000' } };
    expect(validate(repeat)).toEqual({ ok: true });
    expect(validate({ ...repeat, payload: { ...repeat.payload, joined: undefined } }).ok).toBe(false);
    expect(validate({ ...judgement, payload: { ...judgement.payload, joined: '1000' } }).ok).toBe(false);
  });

  it('takes what a browser saw as evidence, and a symptom on every page as one route', () => {
    const crawled = {
      ...signal,
      actor: 'crawler',
      payload: {
        sense: 'crawler',
        check: 'security headers',
        route: '*',
        version: 'v0.9.2',
        symptom: 'missing-header',
        evidence: [
          {
            kind: 'http',
            method: 'GET',
            url: '/products?page=2',
            status: 200,
            headers: { 'content-security-policy': null },
            timings: { firstByteMs: 41, totalMs: 58 },
            redirects: [],
          },
          {
            kind: 'console',
            route: '/products',
            version: 'v0.9.2',
            messages: [{ level: 'error', text: 'Uncaught TypeError: x is undefined' }],
          },
          {
            kind: 'accessibility',
            route: '/products',
            version: 'v0.9.2',
            findings: [
              {
                rule: 'image-alt',
                impact: 'critical',
                help: 'Images must have alternative text',
                elements: [{ selector: 'main img', box: { x: 10, y: 20, width: 200, height: 150 } }],
              },
            ],
          },
        ],
      },
    };
    expect(validate(crawled)).toEqual({ ok: true });
  });

  it('only lets work return upstream', () => {
    const back = {
      ...opened,
      type: 'work.returned',
      payload: { from: 'gates', to: 'build', reason: 'A check failed' },
    };
    expect(validate(back)).toEqual({ ok: true });
    expect(validate({ ...back, payload: { from: 'build', to: 'gates', reason: 'Onwards' } }).ok).toBe(false);
  });
});

describe('public views', () => {
  it('exist for every type', () => {
    expect(Object.keys(PUBLIC_VIEWS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('never carry a report’s text, even when a summary quotes it', () => {
    for (const event of [signal, judgement]) {
      const view = viewOf(event);
      expect(JSON.stringify(view)).not.toContain('ten past four');
      expect(validate({ ...event, ...view })).toEqual({ ok: true });
    }
    expect(viewOf(signal).summary).toBe('A visitor reported a problem on /products/clock-stopped');
  });

  it('never carry the query of the page a report came from, which the visitor typed too', () => {
    const fromSearch = {
      ...signal,
      payload: { ...signal.payload, report: { page: '/search?q=something+rude#top', text: REPORT_TEXT } },
    };
    const view = viewOf(fromSearch);
    expect(JSON.stringify(view)).not.toContain('rude');
    expect(view.summary).toBe('A visitor reported a problem on /search');
  });

  it('never carry a visitor’s key', () => {
    expect(JSON.stringify(viewOf(opened))).not.toContain(VISITOR_KEY);
  });

  it('redact anything secret-shaped, wherever it is', () => {
    const view = JSON.stringify(viewOf(gate));
    expect(view).not.toContain('sk-ant-api03');
    expect(view).not.toContain('ghp_');
    expect(view).toContain('FAIL test/money.test.ts');
  });

  it('change nothing the second time', () => {
    for (const event of [opened, signal, judgement, gate]) {
      const once = viewOf(event);
      expect(publicView(event.type, once)).toEqual(once);
    }
  });

  it.each([
    ['an Anthropic key', 'key sk-ant-api03-Zx9_abcdefghijkl', 'key [redacted]'],
    ['a GitHub token', 'GITHUB_TOKEN ghs_abcdefghijklmnopqrstuvwxyz012345', 'GITHUB_TOKEN [redacted]'],
    ['an AWS key id', 'AKIAIOSFODNN7EXAMPLE', '[redacted]'],
    ['a bearer token', 'Authorization: Bearer abc.def.ghi-123', 'Authorization: Bearer [redacted]'],
    [
      'a password in a URL',
      'postgres://factory:hunter2@postgres:5432/factory',
      'postgres://[redacted]@postgres:5432/factory',
    ],
    ['a password field', 'PGPASSWORD=hunter2 psql', 'PGPASSWORD=[redacted] psql'],
    ['a private key', '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----', '[redacted private key]'],
  ])('redact %s', (_name, input, output) => {
    expect(redactSecrets(input)).toBe(output);
  });

  it('leave ordinary output alone', () => {
    const output = 'test/money.test.ts deleted   −42 lines, 6 tests\nrisk  high · tests removed';
    expect(redactSecrets(output)).toBe(output);
    expect(redactSecrets(`cassette ${'f'.repeat(64)}`)).toBe(`cassette ${'f'.repeat(64)}`);
  });
});

describe('upcasting', () => {
  const stored = (type: string, version: number, payload: unknown) => ({ ...opened, seq: 1, type, version, payload });

  // A test-only history for model.called: version 1 counted tokens in one figure, version 2 split input and
  // output, and version 3 (current here) added cached tokens.
  const catalogue: Catalogue = {
    versions: { 'model.called': 3 },
    upcasters: {
      'model.called': {
        1: ({ tokens, ...payload }) => ({ ...payload, tokens: { input: tokens, output: 0 } }),
        2: ({ tokens, ...payload }) => ({ ...payload, tokens: { ...(tokens as object), cacheRead: 0, cacheWrite: 0 } }),
      },
    },
  };

  it('reads an event written at an older version as the current one, through each upcaster', () => {
    const result = upcast(stored('model.called', 1, { agent: 'coder', tokens: 1200 }), catalogue);
    expect(result).toMatchObject({
      ok: true,
      event: {
        version: 3,
        payload: { agent: 'coder', tokens: { input: 1200, output: 0, cacheRead: 0, cacheWrite: 0 } },
      },
    });
  });

  it('leaves a current event as it is', () => {
    expect(upcast(stored('model.called', 3, { agent: 'coder' }), catalogue)).toMatchObject({
      ok: true,
      event: { payload: { agent: 'coder' } },
    });
  });

  it('says when an event is newer than it understands', () => {
    expect(upcast(stored('model.called', 4, {}), catalogue)).toMatchObject({ ok: false, reason: 'newer-version' });
    expect(upcast(stored('robot.danced', 1, {}))).toMatchObject({ ok: false, reason: 'unknown-type' });
    expect(upcast(stored('constructor', 1, {}))).toMatchObject({ ok: false, reason: 'unknown-type' });
  });

  it('fails loudly when a step in the chain is missing', () => {
    const gap = { ...catalogue, upcasters: { 'model.called': { 2: (p: Record<string, unknown>) => p } } };
    expect(() => upcast(stored('model.called', 1, {}), gap)).toThrow(/from version 1 to 2/);
  });
});

describe('the event-log format', () => {
  it('writes one event a line, in the envelope’s order, and reads them back', () => {
    const events = [opened, signal].map((event, i) => ({ ...event, ...viewOf(event), seq: i + 1 }) as PublicEvent);
    const text = formatLog(events);
    expect(text.split('\n')).toHaveLength(3);
    expect(text.startsWith('{"id":')).toBe(true);
    expect(parseLog(text)).toEqual(events);
    expect(text).not.toContain(REPORT_TEXT);
  });

  it('names the line that is not JSON', () => {
    expect(() => parseLog('{}\n{nope}\n')).toThrow('Line 2 of the event log is not JSON');
  });
});
