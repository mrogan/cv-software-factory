import { describe, expect, it } from 'vitest';
import {
  ANSWERS,
  answersTo,
  inScope,
  knownInScope,
  PATH_CHARS,
  recordedPath,
  returnWords,
  sameVersion,
  scopesOverlap,
  sharedPath,
  WORDS_LEAVE_HELD,
} from '../src/line.ts';
import { formatLog, parseLog } from '../src/log-format.ts';
import { PUBLIC_VIEWS, publicView, redactSecrets } from '../src/public.ts';
import { validate, validateSignal } from '../src/schemas.ts';
import type { NewEvent, PublicEvent } from '../src/types.ts';
import { type Catalogue, upcast } from '../src/upcast.ts';
import { EVENT_TYPES, VERSIONS } from '../src/versions.ts';
import { HOLD_CAUSES } from '../src/vocabulary.ts';
import { gate, judgement, opened, REPORT_TEXT, signal, VISITOR_KEY } from './fixtures.ts';

/** An event read back, as one about to be appended again: what it reads as must be valid now. */
const asNew = (event: PublicEvent) => ({ ...opened, type: event.type, version: event.version, payload: event.payload });

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
    const line = { ...opened, type: 'line.started', version: 2, payload: { reason: 'Back from lunch' } };
    expect(validate({ ...line, work_item: null })).toEqual({ ok: true });
    expect(validate(line)).toEqual({ ok: false, problems: ['line.started belongs to the line, not to a work item'] });
    expect(validate({ ...opened, work_item: null })).toEqual({
      ok: false,
      problems: ['work-item.opened needs a work item'],
    });
  });

  it('takes a release’s events on a work item it carries, or on the line when it carries none', () => {
    const started = {
      ...opened,
      type: 'release.started',
      version: 3,
      actor: 'rollouts',
      payload: {
        release: '6d8f9c7b54',
        version: 'v0.9.4',
        previous: 'v0.9.3',
        commit: 'a'.repeat(40),
        image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true },
        watched: true,
        steps: [
          { weight: 25, pauseSeconds: 180, analysis: true },
          { weight: 50, pauseSeconds: 180, analysis: true },
        ],
        dryRun: false,
      },
    };
    expect(validate(started)).toEqual({ ok: true });
    expect(validate({ ...started, work_item: null })).toEqual({ ok: true });
    const stepped = {
      ...started,
      type: 'canary.stepped',
      version: 2,
      payload: {
        release: '6d8f9c7b54',
        version: 'v0.9.4',
        weight: 25,
        analysis: {
          phase: 'successful',
          requests: 231,
          measures: [{ name: 'enough-requests', phase: 'successful', value: 231, limit: 100 }],
        },
        dryRun: false,
      },
    };
    expect(validate({ ...stepped, work_item: null })).toEqual({ ok: true });
    // Martin's abort says when Argo Rollouts acted on it, and whether Stop the line made it.
    const aborted = {
      ...started,
      type: 'release.aborted',
      version: 1,
      actor: 'martin',
      payload: {
        release: '6d8f9c7b54',
        version: 'v0.9.4',
        restored: 'v0.9.3',
        abortedAt: '2026-10-06T06:35:10Z',
        by: 'stop',
      },
    };
    expect(validate(aborted)).toEqual({ ok: true });
    expect(validate({ ...aborted, work_item: null })).toEqual({ ok: true });
    expect(validate({ ...aborted, payload: { ...aborted.payload, by: 'rollouts' } }).ok).toBe(false);
    // An analysis that could not judge the canary ends the release in its own words, with the measures it could not take.
    const errored = {
      ...started,
      type: 'release.errored',
      version: 1,
      actor: 'rollouts',
      payload: {
        release: '6d8f9c7b54',
        version: 'v0.9.4',
        restored: 'v0.9.3',
        weight: 25,
        reason: 'Metric "errors" assessed Error due to consecutiveErrors (5) > consecutiveErrorLimit (4)',
        errored: [{ name: 'errors', phase: 'error', value: null, limit: 0.01, message: 'connection refused' }],
        abortedAt: '2026-10-06T06:35:10Z',
      },
    };
    expect(validate(errored)).toEqual({ ok: true });
    expect(validate({ ...errored, work_item: null })).toEqual({ ok: true });
    expect(validate({ ...errored, payload: { ...errored.payload, weight: 0 } }).ok).toBe(false);
    // A verification is of a work item's ticket: never the line's.
    const verified = {
      ...started,
      type: 'verification.finished',
      version: 4,
      actor: 'factory',
      payload: { outcome: 'cleared', sense: 'probe', check: 'search', against: 'v0.9.3', pages: [], dryRun: false },
    };
    expect(validate(verified)).toEqual({ ok: true });
    // A page names another work item the release carried only when it is not this one's own.
    const page = { page: '/about', route: '/about', screenshot: 'a'.repeat(64), changed: 0.2 };
    const withPage = (p: Record<string, unknown>) =>
      validate({ ...verified, payload: { ...verified.payload, pages: [p] } });
    expect(withPage({ ...page, intended: false, intendedFor: '1073' })).toEqual({ ok: true });
    expect(withPage({ ...page, intended: true, intendedFor: '1073' }).ok).toBe(false);
    expect(validate({ ...verified, work_item: null })).toEqual({
      ok: false,
      problems: ['verification.finished needs a work item'],
    });
  });

  it('reopens a ticket on a sense’s signal, or on any first signal when it undoes a dry run’s verification', () => {
    const back = {
      sense: 'probe',
      check: 'search',
      route: '/search',
      version: 'v0.9.3',
      reason: 'Back',
      dryRun: false,
    };
    const event = { ...opened, type: 'work-item.reopened', version: 3, actor: 'triage', payload: back };
    expect(validate(event)).toEqual({ ok: true });
    expect(validate({ ...event, payload: { ...back, sense: 'report' } })).toEqual({
      ok: false,
      problems: [
        'payload.sense: only a sense’s signal reopens a ticket, unless the reopening undoes a dry run’s verification',
      ],
    });
    expect(validate({ ...event, actor: 'factory', payload: { ...back, sense: 'report', dryRun: true } })).toEqual({
      ok: true,
    });
    // A version 2 reopening was a sense's.
    const { dryRun: _, ...v2 } = back;
    expect(upcast({ type: 'work-item.reopened', version: 2, payload: v2 })).toMatchObject({
      ok: true,
      event: { version: 3, payload: back },
    });
  });

  it('names the image of a release that shipped, and none of a dry run’s', () => {
    const { image: _, ...dry } = {
      release: 'dry-run-1288',
      version: 'a'.repeat(40),
      previous: 'v0.9.3',
      image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true },
      watched: true,
      steps: [{ weight: 25, pauseSeconds: 60, analysis: true }],
      dryRun: true,
    };
    const event = { ...opened, type: 'release.started', version: 3, actor: 'factory', payload: dry };
    expect(validate(event)).toEqual({ ok: true });
    expect(validate({ ...event, payload: { ...dry, dryRun: false } })).toEqual({
      ok: false,
      problems: ['payload.image: a release that shipped names its image, and a dry run’s names none'],
    });
    expect(
      validate({
        ...event,
        payload: { ...dry, image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true } },
      }).ok,
    ).toBe(false);
  });

  it('records a release’s steps as weights held for a while, or none when they are not known', () => {
    const payload = {
      release: '6d8f9c7b54',
      version: 'v0.9.4',
      previous: 'v0.9.3',
      image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true },
      watched: true,
      steps: null,
      dryRun: false,
    };
    const event = { ...opened, type: 'release.started', version: 3, actor: 'rollouts', payload };
    expect(validate(event)).toEqual({ ok: true });
    const withSteps = (steps: unknown) => validate({ ...event, payload: { ...payload, steps } }).ok;
    // A pause with no duration waits for someone to promote the canary. A step is at 1% at the least, as its verdict is.
    expect(withSteps([{ weight: 1, pauseSeconds: null, analysis: false }])).toBe(true);
    expect(withSteps([{ weight: 0, pauseSeconds: 0, analysis: false }])).toBe(false);
    expect(withSteps([{ weight: 101, pauseSeconds: 0, analysis: false }])).toBe(false);
    expect(withSteps([{ weight: 25, pauseSeconds: -1, analysis: false }])).toBe(false);
    expect(withSteps([{ weight: 25, pauseSeconds: 60 }])).toBe(false);
    expect(withSteps(Array.from({ length: 21 }, () => ({ weight: 25, pauseSeconds: 0, analysis: false })))).toBe(false);
    const { steps: _, ...v2 } = payload;
    expect(validate({ ...event, payload: v2 }).ok).toBe(false);
  });

  it('keeps spend caps on the line', () => {
    const capped = {
      ...opened,
      work_item: null,
      type: 'spend.capped',
      version: 2,
      payload: { cap: 'day', limitUsd: 20, spentUsd: 20.01, resets: '2026-10-05T00:00:00.000Z' },
    };
    expect(validate(capped)).toEqual({ ok: true });
    expect(validate({ ...capped, type: 'spend.cleared', payload: { cap: 'day' } })).toEqual({ ok: true });
    const provider = {
      cap: 'provider',
      provider: 'anthropic',
      reason: 'credit',
      message: 'Your credit balance is too low.',
    };
    expect(validate({ ...capped, payload: provider })).toEqual({ ok: true });
    expect(validate({ ...capped, payload: { ...provider, limitUsd: 20 } }).ok).toBe(false);
    expect(validate({ ...capped, type: 'spend.cleared', payload: { cap: 'provider', provider: 'local' } })).toEqual({
      ok: true,
    });
  });

  it('keeps the scoreboard’s figures on the line, consistent, and says when it is off', () => {
    const figures = { keyed: true, entries: 40, found: 9, verified: 3, medianMs: 2_700_000 };
    const score = {
      ...opened,
      work_item: null,
      type: 'score.updated',
      version: 1,
      actor: 'scoreboard',
      payload: figures,
    };
    expect(validate(score)).toEqual({ ok: true });
    expect(validate({ ...score, work_item: '1288' }).ok).toBe(false);
    expect(validate({ ...score, payload: { keyed: false } })).toEqual({ ok: true });
    expect(validate({ ...score, payload: { ...figures, verified: 0, medianMs: null } })).toEqual({ ok: true });
    for (const wrong of [
      { ...figures, verified: 10 }, // more verified than found
      { ...figures, found: 41 }, // more found than there are entries
      { ...figures, medianMs: null }, // verified, with no median
      { ...figures, verified: 0 }, // a median with nothing verified
      { keyed: false, entries: 40 }, // off, with figures
    ]) {
      expect(validate({ ...score, payload: wrong }).ok).toBe(false);
    }
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

  it('takes a report into the inbox only with its text', () => {
    const report = { ...signal.payload, observedAt: signal.ts, artifacts: [] };
    expect(validateSignal(report)).toEqual({ ok: true });
    expect(validateSignal({ ...report, report: { page: '/' } })).toEqual({
      ok: false,
      problems: ['report.text: a report needs its text'],
    });
    expect(validateSignal({ ...report, sense: 'crawler', symptom: 'broken-link' }).ok).toBe(false);
  });

  it('takes a planner’s finding into the inbox with its words and the ticket it was planning, and no symptom', () => {
    const finding = {
      ...signal.payload,
      sense: 'planner',
      check: 'planning ticket #1283',
      planning: '1283',
      observedAt: signal.ts,
    };
    expect(validateSignal({ ...finding, artifacts: [] })).toEqual({ ok: true });
    expect(validateSignal({ ...finding, planning: undefined, artifacts: [] }).ok).toBe(false);
    expect(validateSignal({ ...signal.payload, planning: '1283', observedAt: signal.ts, artifacts: [] }).ok).toBe(
      false,
    );
    expect(validateSignal({ ...finding, report: { page: '/' }, artifacts: [] })).toEqual({
      ok: false,
      problems: ['report.text: a finding needs its text'],
    });
    expect(validateSignal({ ...finding, symptom: 'wrong-result', artifacts: [] }).ok).toBe(false);
  });

  it('takes where each criterion of a spec comes from and the words it quotes there, and a spec that never said', () => {
    const criterion = { given: 'a price of 600 pence', when: 'it is shown', expect: 'it reads £6.00' };
    const spec = { outcome: 'Prices show two digits of pence.', scope: ['src/money.ts'], risks: [], rollout: 'Ships.' };
    const written = { ...opened, type: 'spec.written', version: 3, actor: 'planner' };
    const quoted = { ...criterion, from: 'signal 1', quote: 'a price is in pounds and two digits of pence' };
    expect(validate({ ...written, payload: { ...spec, criteria: [quoted] } })).toEqual({ ok: true });
    expect(validate({ ...written, payload: { ...spec, criteria: [{ ...quoted, quote: ' ' }] } }).ok).toBe(false);
    for (const [version, older] of [
      [1, criterion],
      [2, { ...criterion, from: 'signal 1' }],
    ] as const) {
      expect(upcast({ type: 'spec.written', version, payload: { ...spec, criteria: [older] } })).toMatchObject({
        event: { version: 3, payload: { criteria: [older] } },
      });
    }
  });

  it('only lets work return upstream', () => {
    const back = {
      ...opened,
      type: 'work.returned',
      version: 3,
      payload: { from: 'gates', to: 'build', reason: 'A check failed', round: 2, failed: ['test'] },
    };
    expect(validate(back)).toEqual({ ok: true });
    expect(validate({ ...back, payload: { from: 'build', to: 'gates', reason: 'Onwards' } }).ok).toBe(false);
    const suggested = {
      from: 'review',
      to: 'build',
      reason: 'The review approved, with 2 suggestions',
      suggestions: 2,
    };
    expect(validate({ ...back, payload: { ...suggested, round: 2 } })).toEqual({ ok: true });
  });

  it('takes the coder’s answer to suggestions, declining only those it was given, each once', () => {
    const answered = { ...opened, type: 'suggestions.answered', version: 1, actor: 'coder' };
    const payload = { pullRequest: 12, suggestions: 2, declined: [{ suggestion: 2, reason: 'Outside the scope.' }] };
    expect(validate({ ...answered, payload })).toEqual({ ok: true });
    expect(validate({ ...answered, payload: { ...payload, declined: [] } })).toEqual({ ok: true });
    const declined = (...suggestions: number[]) => suggestions.map((suggestion) => ({ suggestion, reason: 'No.' }));
    expect(validate({ ...answered, payload: { ...payload, declined: declined(3) } }).ok).toBe(false);
    expect(validate({ ...answered, payload: { ...payload, declined: declined(1, 1) } }).ok).toBe(false);
  });

  it('takes a wait on work in flight, naming the work items and the files their specs share', () => {
    const waits = { ...opened, type: 'wait.started', version: 1, actor: 'factory' };
    const payload = { on: ['1028'], files: ['src/search.ts'], reason: 'Waits for #1028, whose spec also changes it' };
    expect(validate({ ...waits, payload })).toEqual({ ok: true });
    expect(validate({ ...waits, payload: { ...payload, on: [] } }).ok).toBe(false);
    expect(validate({ ...waits, payload: { ...payload, files: [] } }).ok).toBe(false);
    expect(validate({ ...waits, work_item: null, payload }).ok).toBe(false);
  });

  it('takes a deploy pull request’s change on a work item, naming the failed checks on a failure only', () => {
    const changed = { ...opened, type: 'deploy.changed', version: 1, actor: 'factory' };
    const payload = { pullRequest: 412, commit: 'b'.repeat(40), state: 'checking' };
    expect(validate({ ...changed, payload })).toEqual({ ok: true });
    for (const state of ['passed', 'merged', 'closed']) {
      expect(validate({ ...changed, payload: { ...payload, state } })).toEqual({ ok: true });
    }
    const failed = { ...payload, state: 'failed', failed: ['e2e'] };
    expect(validate({ ...changed, payload: failed })).toEqual({ ok: true });
    expect(validate({ ...changed, payload: { ...failed, failed: [] } }).ok).toBe(false);
    expect(validate({ ...changed, payload: { ...payload, state: 'failed' } }).ok).toBe(false);
    expect(validate({ ...changed, payload: { ...payload, failed: ['e2e'] } }).ok).toBe(false);
    expect(validate({ ...changed, payload: { ...payload, state: 'ready' } }).ok).toBe(false);
    expect(validate({ ...changed, payload: { ...payload, commit: 'b0b' } }).ok).toBe(false);
    expect(validate({ ...changed, work_item: null, payload }).ok).toBe(false);
  });

  it('takes a look again that says why only when it could not tell, and names the version when it could', () => {
    const looked = { ...opened, type: 'signal.rechecked', version: 1, actor: 'probe' };
    const payload = {
      for: 'release',
      outcome: 'cleared',
      sense: 'probe',
      check: 'search answers',
      release: '6d8f9c7b54-3',
      version: 'd728dbe',
      against: 'c0ffee0',
      carried: ['1033'],
    };
    expect(validate({ ...looked, payload })).toEqual({ ok: true });
    expect(validate({ ...looked, payload: { ...payload, why: 'no reason' } }).ok).toBe(false);
    expect(validate({ ...looked, payload: { ...payload, outcome: 'unsure' } }).ok).toBe(false);
    expect(
      validate({ ...looked, payload: { ...payload, outcome: 'unsure', why: 'the check could not tell' } }),
    ).toEqual({
      ok: true,
    });
    // At the end of a wait with no release of the app recorded, it looked at none.
    const none = { for: 'wait', outcome: 'unsure', check: 'search answers', carried: [], why: 'no release' };
    expect(validate({ ...looked, actor: 'factory', payload: none })).toEqual({ ok: true });
    const { version: _, ...unnamed } = payload;
    expect(validate({ ...looked, payload: unnamed }).ok).toBe(false);
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

  it('never carry a planner’s finding’s words, which are as untrusted as a report’s', () => {
    const finding = {
      ...signal,
      actor: 'planner' as const,
      payload: { ...signal.payload, sense: 'planner' as const, check: 'planning ticket #1283', planning: '1283' },
    };
    const view = viewOf(finding);
    expect(JSON.stringify(view)).not.toContain('ten past four');
    expect(view.summary).toBe('The planner noted something on /products/clock-stopped');
    expect(validate({ ...finding, ...view })).toEqual({ ok: true });
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

  it('carry Martin’s answer to a hold through the redactor, but not his words on a hold about a visitor’s report', () => {
    const answer = (payload: object) =>
      ({
        ...opened,
        type: 'hold.answered',
        version: 2,
        actor: 'martin',
        summary: 'Martin answered #1306 in words',
        payload,
      }) as NewEvent;
    const words = 'Keep the old error page; the key is sk-ant-api03-abcdefghijklmnop';
    const open = viewOf(answer({ decision: 'answered', answer: words, hold: opened.id }));
    expect(open.payload).toEqual({
      decision: 'answered',
      answer: 'Keep the old error page; the key is [redacted]',
      hold: opened.id,
    });
    const report = answer({ decision: 'answered', answer: words, hold: opened.id, report: true });
    const kept = viewOf(report);
    expect(kept).toMatchObject({
      summary: 'Martin answered the hold in words',
      payload: { decision: 'answered', report: true },
    });
    expect(JSON.stringify(kept)).not.toContain('old error page');
    expect(validate({ ...report, ...kept })).toEqual({ ok: true });
    expect(viewOf({ ...report, ...kept } as NewEvent)).toEqual(kept);
  });

  it('redact anything secret-shaped, wherever it is', () => {
    const view = JSON.stringify(viewOf(gate));
    expect(view).not.toContain('sk-ant-api03');
    expect(view).not.toContain('ghp_');
    expect(view).toContain('FAIL test/money.test.ts');
  });

  it('keep a release’s steps, which the console draws the canary by', () => {
    const steps = [
      { weight: 25, pauseSeconds: 180, analysis: true },
      { weight: 50, pauseSeconds: 180, analysis: true },
    ];
    const payload = {
      release: '6d8f9c7b54',
      version: 'v0.9.4',
      previous: 'v0.9.3',
      image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true },
      watched: true,
      steps,
      dryRun: false,
    };
    const view = publicView('release.started', {
      summary: 'v0.9.4 signed and admitted; canary started',
      payload,
      artifacts: [],
    });
    expect(view.payload.steps).toEqual(steps);
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

describe('upcasting the real catalogue', () => {
  it('reads version 1 of model.called as one call, and version 1 caps as they were', () => {
    const v1 = {
      agent: 'coder',
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      settings: { effort: 'medium' },
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0.01,
      durationMs: 900,
      cassette: 'c'.repeat(64),
    };
    const { cassette: _, ...rest } = v1;
    expect(upcast({ type: 'model.called', version: 1, payload: v1 })).toMatchObject({
      ok: true,
      event: { version: 2, payload: { ...rest, calls: 1 } },
    });
    const day = { cap: 'day', limitUsd: 20, spentUsd: 21, resets: '2026-10-05T00:00:00.000Z' };
    expect(upcast({ type: 'spend.capped', version: 1, payload: day })).toMatchObject({
      event: { version: 2, payload: day },
    });
  });

  it('reads a version 1 close as it was, and takes an improvement turned off only at version 2', () => {
    const verified = { outcome: 'verified', reason: 'The probe passed twice in a row' };
    expect(upcast({ type: 'work-item.closed', version: 1, payload: verified })).toMatchObject({
      ok: true,
      event: { version: 2, payload: verified },
    });
    const turnedOff = { outcome: 'turned-off', reason: 'The note box covers the basket total on a phone' };
    const closed = (version: number) => ({
      ...opened,
      type: 'work-item.closed',
      version,
      actor: 'factory',
      payload: turnedOff,
    });
    expect(validate(closed(2)).ok).toBe(true);
    expect(validate(closed(1)).ok).toBe(false);
  });

  it('reads a version 1 judgement of a flag as judging no move, and a version 1 baseline as it was', () => {
    const compared = { flag: 'gift-note', share: 50, outcome: 'passed' };
    expect(upcast({ type: 'flag.compared', version: 1, payload: compared })).toMatchObject({
      ok: true,
      event: { version: 2, payload: { ...compared, moveRevision: 'none' } },
    });
    const checked = { stage: 'checks', flag: 'gift-note', version: 'v0.9.7', revision: 'r7', outcome: 'passed' };
    expect(upcast({ type: 'flag.checked', version: 1, payload: checked })).toMatchObject({
      ok: true,
      event: { version: 2, payload: { ...checked, moveRevision: 'none' } },
    });
    const baseline = { stage: 'off', flag: 'gift-note', version: 'v0.9.7', revision: 'r5' };
    const read = upcast({ type: 'flag.checked', version: 1, payload: baseline });
    expect(read).toMatchObject({ ok: true, event: { version: 2, payload: baseline } });
    expect(read.ok && 'moveRevision' in read.event.payload).toBe(false);
  });

  it('reads a version 1 hold as the cause its kind and stage imply, and as unknown where they imply none', () => {
    const cause = (kind: string, stage: string) => {
      const read = upcast({ type: 'hold.started', version: 1, payload: { stage, kind, reason: 'Held' } });
      return read.ok ? (read.event.payload as { cause: string }).cause : read.reason;
    };
    expect(cause('approval', 'triage')).toBe('suggestion');
    expect(cause('approval', 'plan')).toBe('spec');
    expect(cause('approval', 'review')).toBe('merge');
    expect(cause('question', 'plan')).toBe('question');
    expect(cause('held', 'gates')).toBe('gates');
    expect(cause('held', 'review')).toBe('review');
    expect(cause('held', 'build')).toBe('unknown');
  });

  it('reads versions 2 to 4 of hold.started as they were, and takes a defect the planner noticed at version 4', () => {
    const v2 = { stage: 'gates', kind: 'held', cause: 'gates', reason: 'The gates failed: test' };
    expect(upcast({ type: 'hold.started', version: 2, payload: v2 })).toMatchObject({
      event: { version: 8, payload: v2 },
    });
    const nothing = { stage: 'build', kind: 'held', cause: 'nothing-to-fix', reason: 'The coder found nothing.' };
    expect(upcast({ type: 'hold.started', version: 3, payload: nothing })).toMatchObject({
      event: { version: 8, payload: nothing },
    });
    const finding = {
      stage: 'triage',
      kind: 'held',
      cause: 'finding',
      reason: 'The planner noticed a defect.',
      defect: { fingerprint: { route: '/basket', class: 'wrong-result' }, symptom: 'wrong-result' },
    };
    const hold = (payload: object, version = 8) =>
      validate({ ...opened, type: 'hold.started', version, actor: 'triage', payload });
    expect(hold(finding)).toEqual({ ok: true });
    expect(hold(finding, 3).ok).toBe(false);
    // A finding's hold names its defect, which triage matches a sense's ticket to; no other hold does.
    const { defect, ...unnamed } = finding;
    expect(hold(unnamed).ok).toBe(false);
    expect(hold({ ...nothing, defect }).ok).toBe(false);
  });

  it('reads version 1 of work-item.opened and signal.received as they were, and takes the planner’s at version 2', () => {
    expect(upcast({ type: 'work-item.opened', version: 1, payload: opened.payload })).toMatchObject({
      event: { version: 2, payload: opened.payload },
    });
    expect(upcast({ type: 'signal.received', version: 1, payload: signal.payload })).toMatchObject({
      event: { version: 4, payload: signal.payload },
    });
    const finding = { kind: 'planner-finding', title: 'A finding on /about', sample: false };
    expect(validate({ ...opened, actor: 'planner', payload: finding })).toEqual({ ok: true });
  });

  it('reads version 1 of review.submitted as a review with no findings, and version 2 as it was', () => {
    const v1 = { pullRequest: 12, verdict: 'approved', comments: 2, note: 'Fine.' };
    expect(upcast({ type: 'review.submitted', version: 1, payload: v1 })).toMatchObject({
      event: { version: 4, payload: { pullRequest: 12, verdict: 'approved', note: 'Fine.', findings: [] } },
    });
    const finding = { path: 'src/money.ts', line: 3, blocking: true, rule: 4, comment: 'Format once, at the edge.' };
    const v2 = { pullRequest: 12, verdict: 'changes-requested', note: 'One blocking finding.', findings: [finding] };
    expect(upcast({ type: 'review.submitted', version: 2, payload: v2 })).toMatchObject({
      event: { version: 4, payload: v2 },
    });
    expect(validate({ ...opened, type: 'review.submitted', version: 4, actor: 'reviewer', payload: v2 })).toEqual({
      ok: true,
    });
    const long = { ...v2, findings: [{ ...finding, comment: 'x'.repeat(301) }] };
    expect(validate({ ...opened, type: 'review.submitted', version: 4, actor: 'reviewer', payload: long }).ok).toBe(
      false,
    );
  });

  it('takes a finding that holds one of the review before again at version 4', () => {
    const finding = { path: 'src/money.ts', line: 3, blocking: true, holds: 2, comment: 'Still one short.' };
    const v4 = { pullRequest: 12, verdict: 'changes-requested', note: 'One still blocks.', findings: [finding] };
    const submitted = { ...opened, type: 'review.submitted', actor: 'reviewer', payload: v4 };
    expect(validate({ ...submitted, version: 4 })).toEqual({ ok: true });
    expect(validate({ ...submitted, version: 4, payload: { ...v4, findings: [{ ...finding, holds: 0 }] } }).ok).toBe(
      false,
    );
    expect(upcast({ type: 'review.submitted', version: 3, payload: { ...v4, findings: [] } })).toMatchObject({
      event: { version: 4 },
    });
  });

  it('takes a finding that cites the ticket at version 3', () => {
    const finding = {
      path: 'src/money.ts',
      line: 3,
      blocking: true,
      criterion: 2,
      ticket: true,
      comment: 'No evidence asks this.',
    };
    const v3 = { pullRequest: 12, verdict: 'escalated', note: 'The spec goes beyond its ticket.', findings: [finding] };
    expect(validate({ ...opened, type: 'review.submitted', version: 4, actor: 'reviewer', payload: v3 })).toEqual({
      ok: true,
    });
    expect(validate({ ...opened, type: 'review.submitted', version: 2, actor: 'reviewer', payload: v3 }).ok).toBe(
      false,
    );
  });

  it('reads version 1 of action.refused as it was, and takes the scope fence at version 2', () => {
    const v1 = { mechanism: 'ruleset', action: 'Push to main', output: 'Protected branch update failed.' };
    expect(upcast({ type: 'action.refused', version: 1, payload: v1 })).toMatchObject({
      event: { version: 2, payload: v1 },
    });
    const fenced = {
      mechanism: 'scope-fence',
      action: 'Push the coder’s patch',
      output: 'refused src/server.ts +1 −1',
      files: [{ path: 'src/server.ts', added: 1, removed: 1, allowed: false }],
    };
    expect(validate({ ...opened, type: 'action.refused', version: 2, actor: 'factory', payload: fenced })).toEqual({
      ok: true,
    });
  });

  it('reads version 1 of pull-request.pushed with its own files as the whole change, and version 2 as it was', () => {
    const files = [{ path: 'src/search.ts', added: 3, removed: 5 }];
    const v1 = { number: 12, title: 'fix: search', branch: 'factory/1', attempt: 1, testsFirst: true, files };
    expect(upcast({ type: 'pull-request.pushed', version: 1, payload: v1 })).toMatchObject({
      event: { version: 3, payload: { ...v1, whole: files } },
    });
    expect(upcast({ type: 'pull-request.pushed', version: 2, payload: { ...v1, whole: files } })).toMatchObject({
      event: { version: 3, payload: { ...v1, whole: files } },
    });
  });

  it('reads version 4 of hold.started as it was, and holds for a deploy and a verification at version 5', () => {
    const merge = { stage: 'review', kind: 'approval', cause: 'merge', reason: 'Waits for Martin’s merge' };
    expect(upcast({ type: 'hold.started', version: 4, payload: merge })).toMatchObject({
      event: { version: 8, payload: merge },
    });
    for (const cause of ['deploy', 'verify']) {
      const payload = { stage: 'release', kind: 'approval', cause, reason: 'Waits for Martin' };
      expect(validate({ ...opened, type: 'hold.started', version: 8, actor: 'factory', payload })).toEqual({
        ok: true,
      });
    }
  });

  it('reads version 5 of hold.started as it was, and holds a burst of new problems at version 6', () => {
    const deploy = { stage: 'release', kind: 'approval', cause: 'deploy', reason: 'Waits for a deploy' };
    expect(upcast({ type: 'hold.started', version: 5, payload: deploy })).toMatchObject({
      event: { version: 8, payload: deploy },
    });
    const burst = { stage: 'triage', kind: 'held', cause: 'burst', reason: 'The log watcher found 34 new problems' };
    expect(validate({ ...opened, type: 'hold.started', version: 8, actor: 'triage', payload: burst })).toEqual({
      ok: true,
    });
    expect(validate({ ...opened, type: 'hold.started', version: 5, actor: 'triage', payload: burst }).ok).toBe(false);
  });

  it('reads version 6 of hold.started as it was, and holds a problem seen while its sense’s reads were not healthy at 7', () => {
    const burst = { stage: 'triage', kind: 'held', cause: 'burst', reason: 'The log watcher found 34 new problems' };
    expect(upcast({ type: 'hold.started', version: 6, payload: burst })).toMatchObject({
      event: { version: 8, payload: burst },
    });
    const environment = { stage: 'triage', kind: 'held', cause: 'environment', reason: 'Loki was not healthy' };
    const hold = (version: number) =>
      validate({ ...opened, type: 'hold.started', version, actor: 'triage', payload: environment });
    expect(hold(8)).toEqual({ ok: true });
    expect(hold(6).ok).toBe(false);
  });

  it('reads version 7 of hold.started as it was, and records a spend hold’s spend at 8', () => {
    const spend = { stage: 'build', kind: 'held', cause: 'spend', reason: 'Spent its cap', limitUsd: 1 };
    expect(upcast({ type: 'hold.started', version: 7, payload: spend })).toMatchObject({
      event: { version: 8, payload: spend },
    });
    const hold = (version: number) =>
      validate({ ...opened, type: 'hold.started', version, actor: 'factory', payload: { ...spend, spentUsd: 1.02 } });
    expect(hold(8)).toEqual({ ok: true });
  });

  it('reads version 1 of hold.answered as it was, and names the hold and a report’s at 2', () => {
    const approved = { decision: 'approved', answer: 'Go on' };
    expect(upcast({ type: 'hold.answered', version: 1, payload: approved })).toMatchObject({
      event: { version: 2, payload: approved },
    });
    const answer = (payload: object) =>
      validate({ ...opened, type: 'hold.answered', version: 2, actor: 'martin', payload });
    expect(answer({ ...approved, hold: opened.id, report: true })).toEqual({ ok: true });
    expect(answer({ ...approved, hold: 'hold-1' }).ok).toBe(false);
    expect(answer({ ...approved, report: false }).ok).toBe(false);
  });

  it('reads version 1 of line.started as it was, and takes a reason, and no autonomy level, at 2', () => {
    expect(upcast({ type: 'line.started', version: 1, payload: { autonomy: 'guarded' } })).toMatchObject({
      event: { version: 2, payload: { autonomy: 'guarded' } },
    });
    const started = (payload: object) =>
      validate({ ...opened, work_item: null, type: 'line.started', version: 2, actor: 'martin', payload });
    expect(started({ reason: 'The fix for the gateway is in' })).toEqual({ ok: true });
    expect(started({})).toEqual({ ok: true });
    expect(started({ autonomy: 'supervised', reason: 'Morning' })).toEqual({ ok: true });
    expect(started({ reason: '' }).ok).toBe(false);
  });

  it('reads version 1 of release.controlled as the panel’s, and marks Stop the line’s abort at 2', () => {
    const control = { action: 'abort', release: '68ff668868-4', version: 'v0.9.4', weight: 25 };
    expect(upcast({ type: 'release.controlled', version: 1, payload: control })).toMatchObject({
      event: { version: 2, payload: control },
    });
    const controlled = (payload: object) =>
      validate({ ...opened, work_item: null, type: 'release.controlled', version: 2, actor: 'martin', payload });
    expect(controlled({ ...control, stop: true })).toEqual({ ok: true });
    expect(controlled({ ...control, action: 'pause', stop: true }).ok).toBe(false);
    expect(controlled({ ...control, stop: false }).ok).toBe(false);
  });

  it('reads version 3 of signal.received as it was, and takes triage’s look at what the sense reads at 4', () => {
    const logs = { sense: 'logs', check: 'every request leaves a record', route: '/about', version: 'v0.9.2' };
    expect(upcast({ type: 'signal.received', version: 3, payload: logs })).toMatchObject({
      event: { version: 4, payload: logs },
    });
    const environment = {
      at: '2026-10-13T19:47:57.000Z',
      dependencies: [
        { name: 'loki', healthy: false, saw: 'no record stored from anything in the 5 minutes before' },
        { name: 'disk', healthy: null, saw: 'could not ask: prometheus-server/api/v1/query answered 503' },
      ],
    };
    const seen = (payload: object) =>
      validate({ ...signal, actor: 'logs', summary: 'A request left no record', payload });
    expect(seen({ ...logs, symptom: 'missing-log', environment })).toEqual({ ok: true });
    const wrong = { ...environment, dependencies: [{ name: 'grafana', healthy: true, saw: 'answered' }] };
    expect(seen({ ...logs, symptom: 'missing-log', environment: wrong }).ok).toBe(false);
    // The look is triage's to take: a sense cannot leave one in the inbox.
    const inbox = { ...logs, symptom: 'missing-log', observedAt: signal.ts, artifacts: [] };
    expect(validateSignal(inbox)).toEqual({ ok: true });
    expect(validateSignal({ ...inbox, environment }).ok).toBe(false);
  });

  it('reads version 2 of release.started as a release whose steps are not known', () => {
    const payload = {
      release: '6d8f9c7b54',
      version: 'v0.9.4',
      previous: 'v0.9.3',
      image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true },
      watched: true,
      dryRun: false,
    };
    const read = upcast({ type: 'release.started', version: 2, payload });
    expect(read).toEqual({
      ok: true,
      event: { type: 'release.started', version: 3, payload: { ...payload, steps: null } },
    });
    expect(read.ok && validate(asNew(read.event))).toEqual({ ok: true });
  });

  it('reads version 1 of a release’s events as a watched release that shipped, told apart by its version', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const started = { version: 'v0.9.1', previous: 'v0.9.0', digest, signed: true, admitted: true };
    const read = upcast({ type: 'release.started', version: 1, payload: started });
    expect(read).toEqual({
      ok: true,
      event: {
        type: 'release.started',
        version: 3,
        payload: {
          release: 'v0.9.1',
          version: 'v0.9.1',
          previous: 'v0.9.0',
          image: { digest, signed: true, admitted: true },
          watched: true,
          steps: null,
          dryRun: false,
        },
      },
    });
    expect(read.ok && validate(asNew(read.event))).toEqual({ ok: true });
    const promoted = upcast({
      type: 'release.promoted',
      version: 1,
      payload: { version: 'v0.9.1', previous: 'v0.9.0' },
    });
    expect(promoted.ok && validate(asNew(promoted.event))).toEqual({ ok: true });
  });

  it('reads version 1 of canary.stepped as a passing step with each version’s figures', () => {
    const analysis = {
      errorRate: { canary: 0.0022, baseline: 0.0021 },
      p99Ms: { canary: 140, baseline: 138 },
      journeys: { canary: [6, 6], baseline: [24, 24] },
    };
    const read = upcast({ type: 'canary.stepped', version: 1, payload: { version: 'v0.9.1', weight: 25, analysis } });
    expect(read).toMatchObject({
      event: {
        version: 2,
        payload: {
          release: 'v0.9.1',
          weight: 25,
          analysis: { phase: 'successful', requests: null, measures: [] },
          figures: {
            canary: { requests: null, errorRate: 0.0022, p99Ms: 140, journeys: [6, 6] },
            baseline: { requests: null, errorRate: 0.0021, p99Ms: 138, journeys: [24, 24] },
          },
          dryRun: false,
        },
      },
    });
    expect(read.ok && validate(asNew(read.event))).toEqual({ ok: true });
  });

  it('reads version 1 of release.rolled-back as one failed measure, named by its label, with its series', () => {
    const v1 = {
      version: 'v0.9.1',
      restored: 'v0.9.0',
      weight: 5,
      reason: 'p99 latency on the canary rose to three times the baseline’s',
      analysis: { metric: 'p99 latency', unit: 'ms', stepSeconds: 20, canary: [140, 412], baseline: [138, 139], at: 1 },
    };
    const read = upcast({ type: 'release.rolled-back', version: 1, payload: v1 });
    expect(read).toMatchObject({
      event: {
        version: 3,
        payload: {
          release: 'v0.9.1',
          failed: [
            {
              name: 'p99-latency',
              phase: 'failed',
              value: null,
              limit: null,
              message: v1.reason,
              series: { label: 'p99 latency', unit: 'ms', stepSeconds: 20, canary: [140, 412], at: 1 },
            },
          ],
          dryRun: false,
        },
      },
    });
    expect(read.ok && validate(asNew(read.event))).toEqual({ ok: true });
    // A label that gives no name that starts with a letter is named for what it is.
    const odd = { ...v1, analysis: { ...v1.analysis, metric: '99th percentile' } };
    const named = upcast({ type: 'release.rolled-back', version: 1, payload: odd });
    expect(named).toMatchObject({ event: { payload: { failed: [{ name: 'metric' }] } } });
    expect(named.ok && validate(asNew(named.event))).toEqual({ ok: true });
  });

  it('reads version 2 of release.rolled-back as it was, its failed looks not counted, and takes a count of them', () => {
    const latency = { name: 'latency', phase: 'failed', value: 0.276, limit: 0 };
    const v2 = { release: 'r', version: 'v0.9.1', restored: 'v0.9.0', weight: 25, reason: 'Failed', dryRun: false };
    const read = upcast({ type: 'release.rolled-back', version: 2, payload: { ...v2, failed: [latency] } });
    expect(read).toMatchObject({ event: { version: 3, payload: { failed: [latency] } } });
    expect(read.ok && validate(asNew(read.event))).toEqual({ ok: true });
    const counted = (failures: number) =>
      validate({
        ...opened,
        type: 'release.rolled-back',
        version: 3,
        actor: 'rollouts',
        payload: { ...v2, failed: [{ ...latency, failures }] },
      });
    expect(counted(2)).toEqual({ ok: true });
    expect(counted(0).ok).toBe(false);
    expect(counted(1.5).ok).toBe(false);
  });

  it('reads version 1 of verification.finished as a verification that ran, by a sense it never named', () => {
    const v1 = { outcome: 'cleared', check: 'Every page', against: 'v0.9.0', pages: [] };
    const read = upcast({ type: 'verification.finished', version: 1, payload: v1 });
    expect(read).toMatchObject({ event: { version: 4, payload: { ...v1, dryRun: false } } });
    expect(read.ok && validate(asNew(read.event))).toEqual({ ok: true });
  });

  it('reads version 1 of work.returned as it was, with no round', () => {
    const v1 = { from: 'review', to: 'build', reason: 'Review asked for changes' };
    expect(upcast({ type: 'work.returned', version: 1, payload: v1 })).toMatchObject({
      event: { version: 3, payload: v1 },
    });
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

describe('the answers a hold takes', () => {
  it('are each that does something, and words on one of triage’s holds, kept with it', () => {
    for (const cause of HOLD_CAUSES) {
      const offered = answersTo(cause);
      expect(offered, cause).toContain('rejected');
      for (const answer of offered) {
        const kept = answer === 'answered' && WORDS_LEAVE_HELD.includes(cause);
        if (!kept) expect(ANSWERS[cause][answer], `${cause}: ${answer}`).not.toBe('wait');
      }
    }
    expect(answersTo('gates')).toEqual(['approved', 'answered', 'rejected']);
    // A fix waiting for Martin's deploy, which a release carrying it ends by itself, takes only his rejection.
    expect(answersTo('deploy')).toEqual(['rejected']);
    // He merges on GitHub: his words send the work back, and nothing here approves it.
    expect(answersTo('merge')).toEqual(['answered', 'rejected']);
    // Approving a suggestion means nothing until improvements do.
    expect(answersTo('suggestion')).toEqual(['answered', 'rejected']);
    expect(answersTo('finding')).toEqual(['approved', 'answered', 'rejected']);
  });
});

describe('a return in words', () => {
  it('says how many findings blocked, suggestions went back or checks failed, and only what the return records', () => {
    expect(returnWords({ from: 'review', blocking: 2 })).toBe('2 blocking');
    expect(returnWords({ from: 'review', suggestions: 1 })).toBe('1 suggestion');
    expect(returnWords({ from: 'review', suggestions: 3 })).toBe('3 suggestions');
    expect(returnWords({ from: 'gates', failed: ['test'] })).toBe('1 check failed');
    expect(returnWords({ from: 'gates', failed: ['test', 'lint'] })).toBe('2 checks failed');
    // The gates fail a run that names no check all the same.
    expect(returnWords({ from: 'gates', failed: [] })).toBe('1 check failed');
    expect(returnWords({ from: 'review' })).toBe('sent back from review');
  });
});

describe('a scope entry', () => {
  it('records a path of the whole change longer than an event takes cut to fit, and marked, between characters', () => {
    const fits = `src/${'a'.repeat(PATH_CHARS - 7)}.ts`;
    expect(recordedPath(fits)).toEqual({ path: fits });
    const long = `src/${'a'.repeat(PATH_CHARS)}/b.ts`;
    const cut = recordedPath(long);
    expect(cut).toEqual({ path: `${long.slice(0, PATH_CHARS - 1)}…`, cut: true });
    expect(cut.path).toHaveLength(PATH_CHARS);
    // A character outside the Basic Multilingual Plane across the cut is left out whole, not split.
    const astral = `${'a'.repeat(PATH_CHARS - 2)}😀b`;
    expect(recordedPath(astral)).toEqual({ path: `${'a'.repeat(PATH_CHARS - 2)}…`, cut: true });
    const pushed = (path: string) =>
      validate({
        ...opened,
        type: 'pull-request.pushed',
        version: VERSIONS['pull-request.pushed'],
        actor: 'coder',
        payload: {
          number: 12,
          title: 'fix: a long path',
          branch: 'factory/1-a-long-path',
          attempt: 1,
          testsFirst: true,
          files: [{ path: 'src/money.ts', added: 1, removed: 1 }],
          whole: [{ ...recordedPath(path), added: 1, removed: 0 }],
        },
      }).ok;
    expect(pushed(long)).toBe(true);
    expect(pushed(astral)).toBe(true);
  });

  it('knows a cut path is in a scope only when a folder entry holds what was kept of it', () => {
    const cut = recordedPath(`docs/${'a'.repeat(PATH_CHARS)}/b.md`);
    expect(knownInScope(cut, ['docs/'])).toBe(true);
    // A file entry, or a pattern, could turn on what was cut off.
    expect(knownInScope(cut, ['docs/*'])).toBe(false);
    expect(knownInScope(cut, ['docs/**/b.md'])).toBe(false);
    expect(knownInScope(cut, ['src/'])).toBe(false);
    // `docs/*` takes in the kept part, one segment with no slash, but not the path it was cut from.
    expect(inScope(cut.path, ['docs/*'])).toBe(true);
    expect(knownInScope({ path: 'docs/a.md' }, ['docs/*'])).toBe(true);
  });

  it('reads `**` as whole segments: any folder or none, never part of a name', () => {
    expect(inScope('test.ts', ['**/test.ts'])).toBe(true);
    expect(inScope('src/deep/test.ts', ['**/test.ts'])).toBe(true);
    expect(inScope('latest.ts', ['**/test.ts'])).toBe(false);
    expect(inScope('src/test.ts', ['src/**/test.ts'])).toBe(true);
    expect(inScope('src/latest.ts', ['src/**/test.ts'])).toBe(false);
    expect(inScope('src/a/b.ts', ['src/**'])).toBe(true);
    expect(inScope('ab', ['a**/b'])).toBe(false);
    expect(inScope('ax/y/b', ['a**/b'])).toBe(true);
  });

  it('takes in a path with a line or paragraph separator in it as any other', () => {
    expect(inScope('deploy/a\u2028b.yaml', ['deploy/'])).toBe(true);
    expect(inScope('src/a\u2029b/Dockerfile', ['**/Dockerfile'])).toBe(true);
    expect(inScope('a\nb.ts', ['*.ts'])).toBe(true);
  });
});

describe('two scopes that share a file', () => {
  it('share equal files, a file in a folder, and a file a pattern matches, either way round', () => {
    expect(scopesOverlap(['src/search.ts', 'test/search.test.ts'], ['src/search.ts'])).toEqual(['src/search.ts']);
    expect(scopesOverlap(['test/'], ['test/search.test.ts'])).toEqual(['test/']);
    expect(scopesOverlap(['test/search.test.ts'], ['test/'])).toEqual(['test/search.test.ts']);
    expect(scopesOverlap(['src/*.ts'], ['src/money.ts'])).toEqual(['src/*.ts']);
    expect(scopesOverlap(['src/'], ['src/**/*.ts'])).toEqual(['src/']);
    expect(scopesOverlap(['docs/*AGENTS.md'], ['**/AGENTS.md'])).toEqual(['docs/*AGENTS.md']);
    expect(scopesOverlap(['src/*test.ts'], ['**/test.ts'])).toEqual(['src/*test.ts']);
  });

  it('share a file two patterns both take in, though neither takes in the other', () => {
    // Both take in `src/test.ts`; tried as samples of each other, neither did.
    expect(sharedPath('**/test.ts', 'src/**')).toBe('src/test.ts');
    expect(scopesOverlap(['**/test.ts'], ['src/**'])).toEqual(['**/test.ts']);
    expect(scopesOverlap(['src/**'], ['**/test.ts'])).toEqual(['src/**']);
    expect(scopesOverlap(['*/money.ts'], ['src/*.ts'])).toEqual(['*/money.ts']);
  });

  it('share nothing when no file is in both', () => {
    expect(scopesOverlap(['src/search.ts', 'test/'], ['src/money.ts', 'docs/'])).toEqual([]);
    expect(scopesOverlap(['src/search.ts'], ['src/search.tsx'])).toEqual([]);
  });
});

describe('the same version', () => {
  it('matches a commit named in full or shortened, and nothing else', () => {
    expect(sameVersion('d728dbe', `d728dbe${'0'.repeat(33)}`)).toBe(true);
    expect(sameVersion('v0.9.3', 'v0.9.3')).toBe(true);
    expect(sameVersion('d728dbe', 'd728dbf')).toBe(false);
  });
});
