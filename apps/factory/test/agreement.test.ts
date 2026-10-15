import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import type { Sample } from '../src/clients/http.ts';
import {
  agree,
  combine,
  count,
  judge,
  logSilent,
  type RouteCounts,
  requestsBetween,
  signalForSilentLog,
  TOLERANCE,
} from '../src/logs/agreement.ts';
import { type Backends, Watcher } from '../src/logs/watcher.ts';
import { VERSION } from './fakes.ts';

describe('agreeing counts', () => {
  it.each([
    [10, 10, true],
    [10, 12, true], // within three
    [100, 118, true], // within a fifth
    [100, 130, false],
    [0, 4, false],
    [0, 3, true],
  ])('%i and %i: %s', (a, b, expected) => {
    expect(agree(a, b, TOLERANCE)).toBe(expected);
  });
});

describe('judging a route from its three counts', () => {
  it.each([
    ['all agree', { metrics: 40, logs: 41, traces: 40 }, undefined],
    ['a route with almost no traffic is not judged', { metrics: 2, logs: 0, traces: 2 }, undefined],
    ['no log record at all for requests counted elsewhere', { metrics: 40, logs: 0, traces: 40 }, 'missing-log'],
    ['far too few log records', { metrics: 40, logs: 10, traces: 41 }, 'missing-log'],
    ['metrics that count too few', { metrics: 10, logs: 40, traces: 40 }, 'wrong-metric'],
    ['metrics that count too many', { metrics: 90, logs: 40, traces: 41 }, 'wrong-metric'],
    ['all three disagree: nobody can say which is wrong', { metrics: 10, logs: 40, traces: 90 }, undefined],
    ['traces that are late are not the metrics’ fault', { metrics: 40, logs: 40 }, undefined],
    ['without traces, a log that lacks requests the metrics counted', { metrics: 40, logs: 0 }, 'missing-log'],
    ['more log records than requests counted is not a missing log', { metrics: 10, logs: 40, traces: 10 }, undefined],
  ] as const)('%s', (_what, counts, expected) => {
    expect(judge(counts)).toBe(expected);
  });
});

const entry = (path: string, metrics: number, logs: number, traces?: number, route = path): RouteCounts => ({
  path,
  route,
  version: VERSION,
  metrics,
  logs,
  ...(traces === undefined ? {} : { traces }),
});

describe('two windows as one', () => {
  it('adds each route’s counts', () => {
    const both = combine([entry('/a', 9, 9, 9), entry('/b', 1, 1, 1)], [entry('/a', 1, 1, 1), entry('/c', 5, 5, 5)]);
    expect(Object.fromEntries(both.map((e) => [e.path, [e.metrics, e.logs, e.traces]]))).toEqual({
      '/a': [10, 10, 10],
      '/b': [1, 1, 1],
      '/c': [5, 5, 5],
    });
  });

  it('puts a burst at the edge of the windows in the same place for every record', () => {
    // The log counted the burst in the first window and the metrics, a minute behind, in the second.
    const first = entry('/a', 0, 9, 9);
    const second = entry('/a', 9, 0, 0);
    expect(judge(first)).toBe('wrong-metric');
    expect(judge(second)).toBe('wrong-metric');
    expect(combine([first], [second]).map((e) => judge(e))).toEqual([undefined]);
  });

  it('does not know the traces of two windows unless it knew both', () => {
    const [both] = combine([entry('/a', 9, 9, 9)], [entry('/a', 1, 1)]);
    expect(both?.traces).toBeUndefined();
  });
});

describe('counting the metrics', () => {
  it('takes each series’ counter now less its counter then, before summing them', () => {
    const expr = requestsBetween('job="app"', 300);
    expect(expr).toContain('offset 300s');
    expect(expr.startsWith('sum by (http_route, service_version) (')).toBe(true);
  });

  it('counts a series born in the window, or one whose counter restarted, from nothing', () => {
    const expr = requestsBetween('job="app"', 300);
    // A series that did not exist then falls back to itself times zero.
    expect(expr).toContain('or http_server_request_duration_seconds_count{job="app", http_route!=""} * 0');
    // A series whose difference went below zero restarted: what it holds now is what it counted since.
    expect(expr).toMatch(/>= 0\) or \(http_server_request_duration_seconds_count\{[^}]*\} unless/);
  });
});

describe('judging windows in pairs', () => {
  it('never pairs a window with one before a gap: a window that could not be counted ends the pair', async () => {
    let failing = false;
    const counted = async () => {
      if (failing) throw new Error('Loki is down');
      return [];
    };
    const backends = {
      objectives,
      prometheus: { instant: counted },
      loki: { instant: counted },
      tempo: { serverSpans: async () => ({ spans: [], complete: true }) },
      outbox: { send: async () => {} },
      log: { info: () => {}, warn: () => {} },
    } as unknown as Backends;
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    const previous = () => (watcher as unknown as { previousWindow: unknown }).previousWindow;
    const at = (minutes: number) => new Date(Date.UTC(2026, 9, 4, 9, minutes));

    await watcher.checkAgreement(at(10));
    expect(previous()).toBeDefined();
    failing = true;
    await expect(watcher.checkAgreement(at(15))).rejects.toThrow('Loki is down');
    expect(previous()).toBeUndefined();
  });
});

describe('a log silent for every route', () => {
  it.each([
    [
      'every route’s requests, and none in the log',
      [entry('/a', 40, 0, 40), entry('/b', 20, 0, 20), entry('/c', 9, 0)],
      true,
    ],
    ['a stray record or two at the edge of the window', [entry('/a', 40, 2, 40), entry('/b', 20, 1, 20)], true],
    ['one route quiet, the others logged', [entry('/a', 40, 0, 40), entry('/b', 20, 20, 20), entry('/c', 9, 9)], false],
    [
      'two routes quiet beside a busy one logged',
      [entry('/a', 40, 0, 40), entry('/b', 20, 0), entry('/c', 90, 90)],
      false,
    ],
    [
      'a quiet log beside a light route logged',
      [entry('/a', 40, 0, 40), entry('/b', 20, 0, 20), entry('/c', 4, 4)],
      false,
    ],
    ['only one route had requests', [entry('/a', 40, 0, 40), entry('/b', 2, 0, 2)], false],
    [
      'two paths of one route are one route',
      [entry('/p/x', 40, 0, 40, '/p/:slug'), entry('/p/y', 20, 0, 20, '/p/:slug')],
      false,
    ],
    ['nothing anywhere', [entry('/a', 0, 0, 0), entry('/b', 0, 0)], false],
  ] as const)('%s: %s', (_what, entries, expected) => {
    expect(logSilent([...entries])).toBe(expected);
  });

  const end = new Date(Date.UTC(2026, 9, 13, 19, 47));
  const other = 'v0.9.3';

  it('is one signal on every route, the busiest routes’ logs shown as they should have been', () => {
    const entries = [
      entry('/products/glove-left', 30, 0, 30, '/products/:slug'),
      entry('/products/glove-right', 25, 0, 25, '/products/:slug'),
      entry('/about', 20, 0, 20),
      { ...entry('/departments/home', 60, 0, 60, '/departments/:slug'), version: other },
    ];
    const signal = signalForSilentLog(entries, end) as InboxSignal;
    expect(validateSignal(signal)).toEqual({ ok: true });
    expect(signal).toMatchObject({ sense: 'logs', route: '*', symptom: 'missing-log', version: VERSION });
    expect(signal.evidence).toEqual([
      { kind: 'logs', route: '/departments/:slug', version: other, requests: 60, lines: [] },
      { kind: 'logs', route: '/products/:slug', version: VERSION, requests: 55, lines: [] },
      { kind: 'logs', route: '/about', version: VERSION, requests: 20, lines: [] },
    ]);
  });

  it('shows no more routes than a signal holds', () => {
    const entries = Array.from({ length: 12 }, (_, i) => entry(`/r${i}`, 10 + i, 0));
    const signal = signalForSilentLog(entries, end) as InboxSignal;
    expect(validateSignal(signal)).toEqual({ ok: true });
    expect(signal.evidence?.map((e) => ('route' in e ? e.route : ''))).toEqual([
      '/r11',
      '/r10',
      '/r9',
      '/r8',
      '/r7',
      '/r6',
      '/r5',
      '/r4',
    ]);
  });

  it('is nothing when the metrics do not say which version served the requests', () => {
    expect(signalForSilentLog([{ ...entry('/a', 40, 0), version: undefined }], end)).toBeUndefined();
  });
});

/** Backends that answer each query from what a test says the records hold. */
function records(options: {
  metrics: Record<string, number>;
  window: () => Sample[];
  day: () => Sample[] | Promise<Sample[]>;
  sent?: InboxSignal[];
}) {
  const days: string[] = [];
  const backends = {
    objectives,
    prometheus: {
      instant: async () =>
        Object.entries(options.metrics).map(([path, value]) => ({
          labels: { http_route: path, service_version: VERSION },
          value,
        })),
      range: async () => undefined,
    },
    loki: {
      instant: async (query: string) => {
        if (!query.includes('[24h]')) return options.window();
        days.push(query);
        return options.day();
      },
    },
    tempo: { serverSpans: async () => ({ spans: [], complete: true }) },
    outbox: { send: async (signal: InboxSignal) => void options.sent?.push(signal) },
    log: { info: () => {}, warn: () => {} },
  } as unknown as Backends;
  return { backends, days };
}

const logged = (path: string, route: string, value: number): Sample => ({ labels: { path, route }, value });
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 13, 19, minutes));

describe('placing a path whose window the log is silent for', () => {
  const metrics = { '/products/glove-left': 30, '/products/glove-right': 20, '/about': 15 };
  const day = [
    logged('/products/glove-left', '/products/:slug', 300),
    logged('/products/glove-right', '/products/:slug', 200),
  ];

  it('takes the route the log gave it before, and the window’s own log first', async () => {
    const { backends } = records({ metrics, window: () => [logged('/about', '/about', 15)], day: () => day });
    const known = new Map([
      ['/products/glove-left', '/products/:slug'],
      ['/about', '/stale'],
    ]);
    const { routes } = await count(objectives, backends, at(40), at(45), known);
    expect(Object.fromEntries(routes.map((e) => [e.path, e.route]))).toEqual({
      '/products/glove-left': '/products/:slug',
      '/products/glove-right': '/products/glove-right',
      '/about': '/about',
    });
  });

  it('signals a route once, not each of its pages, when its log is missing beside a logged one', async () => {
    const sent: InboxSignal[] = [];
    const { backends } = records({ metrics, window: () => [logged('/about', '/about', 15)], day: () => day, sent });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    await watcher.checkAgreement(at(44));
    await watcher.checkAgreement(at(49));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['/products/:slug', 'missing-log']]);
  });

  it('signals once for the log as a whole when it is silent for every route', async () => {
    const sent: InboxSignal[] = [];
    const { backends } = records({ metrics, window: () => [], day: () => day, sent });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    for (const minutes of [44, 49, 54, 59]) await watcher.checkAgreement(at(minutes));
    expect(sent.map((s) => [s.route, s.symptom])).toEqual([['*', 'missing-log']]);
    expect(sent[0]?.evidence?.map((e) => ('route' in e ? e.route : ''))).toEqual(['/products/:slug', '/about']);
  });

  it('asks the last day’s log once an hour, and keeps the names it knew when the log has none or fails', async () => {
    const sent: InboxSignal[] = [];
    let lookup: () => Sample[] = () => day;
    const { backends, days } = records({
      metrics: { '/products/glove-left': 30, '/about': 15 },
      window: () => [logged('/about', '/about', 15)],
      day: () => lookup(),
      sent,
    });
    const watcher = new Watcher(backends, { errors: new Date(0), reports: new Date(0) });
    for (const minutes of [4, 9, 14]) await watcher.checkAgreement(new Date(Date.UTC(2026, 9, 13, 19, minutes)));
    expect(days).toHaveLength(1);

    // An hour on, the lookup fails, and then finds nothing: the paths it named still have their routes.
    lookup = () => {
      throw new Error('Loki is full');
    };
    await watcher.checkAgreement(new Date(Date.UTC(2026, 9, 13, 20, 9)));
    lookup = () => [];
    await watcher.checkAgreement(new Date(Date.UTC(2026, 9, 13, 20, 14)));
    expect(days).toHaveLength(3);
    expect(new Set(sent.map((s) => s.route))).toEqual(new Set(['/products/:slug']));
  });
});
