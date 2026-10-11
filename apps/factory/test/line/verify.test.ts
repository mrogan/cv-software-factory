/**
 * Verify, by each sense, against stand-ins for the probes worker, Prometheus and Loki: what clears, what persists, and
 * what cannot tell yet, which is never a clear.
 */
import { describe, expect, it } from 'vitest';
import { Loki } from '../../src/clients/loki.ts';
import { Prometheus } from '../../src/clients/prometheus.ts';
import {
  closingComment,
  type FirstSignal,
  judgeObjective,
  type LookOptions,
  look,
  type Target,
  whatCleared,
} from '../../src/line/verify.ts';
import { FakeProbes } from './fakes.ts';

const VERSION = 'b'.repeat(40);
const BEFORE = 'a'.repeat(40);
const PROMOTED = Date.parse('2026-10-11T09:00:00Z');
const target: Target = { version: VERSION, at: new Date(PROMOTED), against: BEFORE, dryRun: false };
/** An hour after the promotion: every window has ended. */
const later = new Date(PROMOTED + 60 * 60_000);
const options = (more: Partial<LookOptions> = {}): LookOptions => ({ now: later, dryRun: false, ...more });

const probe: FirstSignal = {
  sense: 'probe',
  check: 'departments/redirect-loop',
  route: '/departments/:department',
  evidence: [],
};

describe('Verify by a probe or the crawler', () => {
  it('clears when the check passes twice in a row on the version the release promoted', async () => {
    const probes = new FakeProbes({ outcome: 'cleared', version: VERSION, runs: ['passed', 'passed'] });
    expect(await look(probe, target, options({ probes }))).toEqual({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'probe',
        check: 'departments/redirect-loop',
        version: VERSION,
        against: BEFORE,
        pages: [],
        dryRun: false,
      },
    });
    expect(probes.asked).toEqual([
      { sense: 'probe', check: 'departments/redirect-loop', route: '/departments/:department' },
    ]);
  });

  it('persists when it fails twice in a row, with the proof of the last failure', async () => {
    const http = {
      kind: 'http' as const,
      method: 'GET' as const,
      url: '/departments/garden',
      status: null,
      headers: {},
      timings: { firstByteMs: 3, totalMs: 40 },
      redirects: [{ status: 302, location: '/departments/garden' }],
    };
    const probes = new FakeProbes({
      outcome: 'persists',
      version: VERSION,
      runs: ['failed', 'failed'],
      evidence: http,
    });
    const crawler = { ...probe, sense: 'crawler' as const, check: 'redirect-loop@/departments/:department' };
    expect(await look(crawler, target, options({ probes }))).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'persists', sense: 'crawler', evidence: http },
    });
    expect(probes.asked[0]?.sense).toBe('crawler');
  });

  it('cannot tell when the check could not, when the stable Service runs another version, or with no way to ask', async () => {
    const unsure = new FakeProbes({ outcome: 'unsure', version: VERSION, runs: ['passed', 'unsure'], message: 'Slow' });
    expect(await look(probe, target, options({ probes: unsure }))).toMatchObject({ kind: 'wait' });
    const old = new FakeProbes({ outcome: 'cleared', version: BEFORE, runs: ['passed', 'passed'] });
    expect(await look(probe, target, options({ probes: old }))).toEqual({
      kind: 'wait',
      why: `the stable Service runs ${BEFORE}, not ${VERSION}`,
    });
    // A short commit names the same version.
    const short = new FakeProbes({ outcome: 'cleared', version: VERSION.slice(0, 7), runs: ['passed', 'passed'] });
    expect(await look(probe, target, options({ probes: short }))).toMatchObject({ kind: 'finished' });
    expect(await look(probe, target, options())).toMatchObject({ kind: 'wait' });
  });
});

/** Prometheus answering the requests in the window, and the objective's series at one point a minute. */
function prometheus(requests: number, series: (number | null)[]) {
  const asked: string[] = [];
  const client = new Prometheus('http://prometheus.test', async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query') ?? '';
    asked.push(query);
    if (url.pathname === '/api/v1/query') {
      return Response.json({ data: { result: [{ metric: {}, value: [0, String(requests)] }] } });
    }
    const start = Number(url.searchParams.get('start'));
    const values = series.flatMap((value, i) => (value === null ? [] : [[start + i * 60, String(value)]]));
    return Response.json({ data: { result: [{ metric: {}, values }] } });
  });
  return { client, asked };
}

const alert: FirstSignal = { sense: 'metrics', check: 'error ratio', route: '/departments/:department', evidence: [] };
const inside = Array.from({ length: 16 }, () => 0.01);

describe('Verify by an alert on an objective', () => {
  it('clears when the expression stays inside the objective, over the new version’s requests to the route alone', async () => {
    const { client, asked } = prometheus(450, inside);
    const found = await look(alert, target, options({ prometheus: client }));
    expect(found).toMatchObject({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'metrics',
        check: 'error ratio',
        evidence: { kind: 'metric', name: 'Share of requests with a 5xx status', objective: 0.05, stepSeconds: 60 },
      },
    });
    // Every path of the route's, from the new version only; the requests counted over the whole window.
    for (const query of asked) {
      expect(query).toContain('http_route=~"/departments/[^/]+"');
      expect(query).toContain(`service_version="${VERSION}"`);
    }
    expect(asked[0]).toContain('[30m]');
  });

  it('persists when the expression is outside the objective for as long as the alert waits', async () => {
    const { client } = prometheus(450, [...inside.slice(0, 13), 0.2, 0.3, 0.25]);
    expect(await look(alert, target, options({ prometheus: client }))).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'persists' },
    });
  });

  it('cannot tell too soon after the promotion, with too few requests, or on a blip shorter than an alert waits', async () => {
    const soon = prometheus(450, inside);
    const early = new Date(PROMOTED + 10 * 60_000);
    expect(await look(alert, target, options({ prometheus: soon.client, now: early }))).toMatchObject({
      kind: 'wait',
    });
    expect(soon.asked).toEqual([]);
    // Inside the objective throughout, on too little traffic, is not a clear.
    const quiet = prometheus(12, inside);
    expect(await look(alert, target, options({ prometheus: quiet.client }))).toEqual({
      kind: 'wait',
      why: 'the new version served 12 requests, fewer than 20',
    });
    const blip = prometheus(450, [...inside.slice(0, 8), 0.2, ...inside.slice(0, 7)]);
    expect(await look(alert, target, options({ prometheus: blip.client }))).toMatchObject({ kind: 'wait' });
    expect(await look(alert, target, options())).toMatchObject({ kind: 'wait' });
  });

  it('judges a series as the alert would', () => {
    const judge = (values: (number | null)[], served = 100) =>
      judgeObjective(values, { threshold: 1, served, minRequests: 20, holdPoints: 2 });
    expect(judge([0.5, 0.6, null, 0.4])).toEqual({ kind: 'judged', outcome: 'cleared' });
    expect(judge([0.5, 1.5, 1.2, 0.4])).toEqual({ kind: 'judged', outcome: 'persists' });
    // Outside, then no value, then outside: never twice in a row.
    expect(judge([1.5, null, 1.2])).toMatchObject({ kind: 'wait' });
    expect(judge([null, null])).toMatchObject({ kind: 'wait' });
    expect(judge([1.5, 1.5], 10)).toMatchObject({ kind: 'wait' });
  });
});

/** Loki answering the error records and the requests counted, and keeping what it was asked. */
function loki(records: { line: string; fields: Record<string, string> }[], requests: number) {
  const asked: string[] = [];
  const client = new Loki('http://loki.test', async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query') ?? '';
    asked.push(query);
    if (url.pathname === '/loki/api/v1/query') {
      return Response.json({ data: { result: [{ metric: {}, value: [0, String(requests)] }] } });
    }
    const start = BigInt(url.searchParams.get('start') ?? '0');
    return Response.json({
      data: {
        result: records.map((record, i) => ({
          stream: record.fields,
          values: [[String(start + BigInt(i + 1) * 1_000_000_000n), record.line]],
        })),
      },
    });
  });
  return { client, asked };
}

/** The log watcher's signal: the lines it kept, with the path a visitor asked for in them. */
const logs: FirstSignal = {
  sense: 'logs',
  check: 'new error pattern',
  route: '/departments/:department',
  evidence: [
    {
      kind: 'logs',
      route: '/departments/:department',
      version: BEFORE,
      requests: 3,
      lines: [
        {
          ts: '2026-10-11T08:00:00.000Z',
          level: 'error',
          message: 'GET /departments/garden failed: TypeError: Cannot read properties of undefined (reading "slug")',
          traceId: null,
        },
      ],
    },
  ],
};
const error = (path: string, message: string, route = '/departments/:department') => ({
  line: `GET ${path} failed`,
  fields: {
    route,
    path,
    exception_type: 'TypeError',
    exception_message: message,
    service_version: VERSION,
    trace_id: 'f'.repeat(32),
  },
});

describe('Verify by the log watcher', () => {
  it('persists on a record of the same pattern from the new version, on another of the route’s paths', async () => {
    const { client, asked } = loki(
      [
        error('/departments/kitchen', 'Cannot read properties of undefined (reading "slug")'),
        error('/departments/kitchen', 'Something else entirely'),
        error('/about', 'Cannot read properties of undefined (reading "slug")', '/about'),
      ],
      300,
    );
    const found = await look(logs, target, options({ loki: client }));
    expect(found).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'persists', sense: 'logs', version: VERSION },
    });
    const evidence = found.kind === 'finished' ? found.verification.evidence : undefined;
    expect(evidence).toMatchObject({ kind: 'logs', requests: 300, route: '/departments/:department' });
    expect(evidence?.kind === 'logs' && evidence.lines.map((l) => l.message)).toEqual([
      'GET /departments/kitchen failed: TypeError: Cannot read properties of undefined (reading "slug")',
    ]);
    for (const query of asked) expect(query).toContain(`service_version="${VERSION}"`);
    // Only the route's errors are read, so other routes' never crowd them out.
    expect(asked.find((q) => q.includes('severity_text'))).toContain('route="/departments/:department"');
    expect(asked.find((q) => q.includes('count_over_time'))).toContain('route="/departments/:department"');
  });

  it('clears with no record of the pattern in a window with traffic, and cannot tell in one without', async () => {
    const quietly = loki([error('/departments/kitchen', 'Something else entirely')], 300);
    expect(await look(logs, target, options({ loki: quietly.client }))).toMatchObject({
      kind: 'finished',
      verification: { outcome: 'cleared', evidence: { kind: 'logs', requests: 300, lines: [] } },
    });
    const empty = loki([], 4);
    expect(await look(logs, target, options({ loki: empty.client }))).toEqual({
      kind: 'wait',
      why: 'the new version logged 4 requests, fewer than 20',
    });
    // As many records as one look reads, none of them the pattern: the rest might be.
    const crowded = loki(
      Array.from({ length: 5_000 }, () => error('/departments/kitchen', 'Something else entirely')),
      300,
    );
    expect(await look(logs, target, options({ loki: crowded.client }))).toMatchObject({ kind: 'wait' });
    const soon = loki([], 300);
    expect(
      await look(logs, target, options({ loki: soon.client, now: new Date(PROMOTED + 5 * 60_000) })),
    ).toMatchObject({ kind: 'wait' });
    expect(await look(logs, target, options())).toMatchObject({ kind: 'wait' });
  });
});

describe('Verify by the canary', () => {
  const failed = { name: 'latency', phase: 'failed' as const, value: 0.247, limit: 0 };
  const canary: FirstSignal = {
    sense: 'canary',
    check: 'latency',
    route: '*',
    evidence: [{ kind: 'canary', release: '68ff668868', version: BEFORE, against: 'c'.repeat(40), measure: failed }],
  };
  const passing = { name: 'latency', phase: 'successful' as const, value: -0.101, limit: 0 };
  const analysed = (measures: (typeof passing)[]): Target => ({
    ...target,
    analysis: { release: '7fc778d748', measures },
  });

  it('clears when a release that carries the fix was promoted with the measure that failed passing', async () => {
    const cleared = await look(canary, analysed([passing]), options());
    expect(cleared).toEqual({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'canary',
        check: 'latency',
        version: VERSION,
        against: BEFORE,
        evidence: { kind: 'canary', release: '7fc778d748', version: VERSION, against: BEFORE, measure: passing },
        pages: [],
        dryRun: false,
      },
    });
    expect(cleared.kind === 'finished' && whatCleared(cleared.verification)).toBe(
      'The canary’s latency passed against aaaaaaa as bbbbbbb was released, and it was promoted',
    );
  });

  it('holds for Martin when no analysis judged the release, or its last step did not pass the measure', async () => {
    expect(await look(canary, target, options())).toEqual({
      kind: 'hold',
      reason: 'No analysis judged bbbbbbb, which was found live: Martin judges whether its latency cleared',
    });
    expect(await look(canary, analysed([]), options())).toMatchObject({ kind: 'hold' });
    expect(await look(canary, analysed([{ ...passing, phase: 'inconclusive' as never }]), options())).toMatchObject({
      kind: 'hold',
    });
  });
});

describe('Verify when no sense can look', () => {
  it('holds for Martin when only a visitor’s report, or the planner, saw the defect', async () => {
    const report: FirstSignal = { sense: 'report', check: 'visitor report', route: '/about', evidence: [] };
    expect(await look(report, target, options())).toEqual({
      kind: 'hold',
      reason:
        'Only a visitor’s report saw this defect, and no sense can look at it again: Martin judges whether the fix cleared it',
    });
    expect(await look({ ...report, sense: 'planner' }, target, options())).toMatchObject({ kind: 'hold' });
  });
});

describe('a dry run’s verification', () => {
  const dry: Target = { ...target, dryRun: true };

  it('is the dry run’s word, and says so', async () => {
    const probes = new FakeProbes({ outcome: 'persists', version: VERSION, runs: ['failed', 'failed'] });
    expect(await look(probe, dry, options({ dryRun: true, probes }))).toEqual({
      kind: 'finished',
      verification: {
        outcome: 'cleared',
        sense: 'probe',
        check: 'departments/redirect-loop',
        version: VERSION,
        against: BEFORE,
        pages: [],
        dryRun: true,
      },
    });
    // No sense looked.
    expect(probes.asked).toEqual([]);
    expect(whatCleared({ outcome: 'cleared', check: 'x', against: BEFORE, pages: [], dryRun: true })).toBe(
      'The dry run’s word: its release never shipped, so no sense looked',
    );
  });

  it('holds for Martin outside a dry run, which nothing would verify', async () => {
    expect(await look(probe, dry, options())).toMatchObject({ kind: 'hold' });
  });
});

describe('what cleared a work item, on its issue', () => {
  it('says which sense looked, at which version, or that Martin judged it', () => {
    const cleared = { outcome: 'cleared' as const, version: VERSION, against: BEFORE, pages: [], dryRun: false };
    expect(whatCleared({ ...cleared, sense: 'metrics', check: 'latency p95' })).toBe(
      'The latency p95 of bbbbbbb’s requests stayed inside its objective for 30 minutes',
    );
    expect(
      whatCleared({
        ...cleared,
        sense: 'logs',
        check: 'new error pattern',
        evidence: { kind: 'logs', route: '/about', version: VERSION, requests: 300, lines: [] },
      }),
    ).toBe('No error like the one the log watcher saw came from bbbbbbb in 30 minutes, over 300 requests');
    expect(closingComment(undefined, '1001', 'The page is right now')).toBe(
      [
        'Verified in production. Martin judged it cleared, saying: The page is right now.',
        '',
        'The factory’s work item #1001 is closed as verified.',
      ].join('\n'),
    );
  });
});
