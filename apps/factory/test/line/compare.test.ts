/**
 * Verify by variant at the share stage (`compare.ts`): each id on the side the app puts it, against a record made with
 * flagd itself; the generator's figures for each side; the window less the canaries; and the canary's judgement, flag
 * on against flag off.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHARES, type Share } from '../../../../policy/flags.ts';
import { release } from '../../../../policy/release.ts';
import type { Sample } from '../../src/clients/http.ts';
import {
  figuresOf,
  figuresQuery,
  judge,
  quantile,
  type Sides,
  sidesOf,
  signedContext,
  windowOf,
} from '../../src/line/compare.ts';
import { IDS } from '../../src/traffic/share.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const recorded = JSON.parse(readFileSync(join(import.meta.dirname, 'flagd-sides.json'), 'utf8')) as {
  image: string;
  library: string;
  context: unknown;
  sides: Record<string, Record<Share, { on: string[]; rpcOn: string[] }>>;
};

describe('the sides, by flagd’s own rule', () => {
  it('records the flagd the cluster runs, the library the factory evaluates with, and the app’s context', () => {
    const flagd = readFileSync(join(ROOT, 'deploy/base/flagd/flagd.yaml'), 'utf8');
    expect(flagd).toContain(`image: ${recorded.image}`);
    const library = createRequire(join(ROOT, 'apps/factory/package.json'))('@openfeature/flagd-core/package.json') as {
      version: string;
    };
    expect(library.version).toBe(recorded.library);
    expect(recorded.context).toEqual(signedContext('<id>'));
  });

  const cases = Object.keys(recorded.sides).flatMap((flag) => SHARES.map((share) => [flag, share] as const));
  it('records two flags at every share', () => expect(cases).toHaveLength(2 * SHARES.length));

  it.each(cases)('puts each id on the side the app does, for %s at %i%%', (flag, share) => {
    const on: string[] = recorded.sides[flag]?.[share]?.on ?? [];
    const sides = sidesOf(flag, share);
    expect(sides.on).toEqual(on);
    expect(sides.off).toEqual(IDS.filter((id) => !on.includes(id)));
  });

  it('puts ids on different sides for different flags at the same share', () => {
    expect(sidesOf('gift-note', 50).on).not.toEqual(sidesOf('last-one', 50).on);
  });
});

describe('the window', () => {
  const at = (minute: number) => Date.parse('2026-10-27T10:00:00Z') + minute * 60_000;

  it('is one piece with no canary', () => {
    expect(windowOf(at(0), at(30), [])).toEqual({
      pieces: [{ from: at(0), to: at(30) }],
      judgedMs: 30 * 60_000,
      setAsideMs: 0,
    });
  });

  it('sets a canary’s span aside, and counts it', () => {
    const window = windowOf(at(0), at(40), [{ from: at(10), to: at(20) }]);
    expect(window.pieces).toEqual([
      { from: at(0), to: at(10) },
      { from: at(20), to: at(40) },
    ]);
    expect(window.setAsideMs).toBe(10 * 60_000);
    expect(window.judgedMs).toBe(30 * 60_000);
  });

  it('clips a canary that began before the window, and joins ones that overlap', () => {
    const window = windowOf(at(0), at(40), [
      { from: at(-5), to: at(5) },
      { from: at(30), to: at(35) },
      { from: at(33), to: at(38) },
    ]);
    expect(window.pieces).toEqual([
      { from: at(5), to: at(30) },
      { from: at(38), to: at(40) },
    ]);
    expect(window.setAsideMs).toBe(13 * 60_000);
  });

  it('runs a canary still in flight to the end of the window', () => {
    const window = windowOf(at(0), at(40), [{ from: at(25), to: at(40) }]);
    expect(window.pieces).toEqual([{ from: at(0), to: at(25) }]);
    expect(window.setAsideMs).toBe(15 * 60_000);
  });

  it('cuts each piece to whole seconds, as a range is, and drops one under a second', () => {
    const window = windowOf(at(0), at(10) + 500, [{ from: at(10), to: at(10) + 200 }]);
    expect(window.pieces).toEqual([{ from: at(0), to: at(10) }]);
    expect(window.setAsideMs).toBe(200);
    expect(windowOf(at(0) + 1500, at(1), []).pieces).toEqual([{ from: at(0) + 2000, to: at(1) }]);
  });
});

/** An id's buckets, as Prometheus answers the query: cumulative, by upper bound, for one class of answer. */
const series = (id: string, statusClass: string, buckets: [string, number][]): Sample[] =>
  buckets.map(([le, value]) => ({ labels: { share_id: id, status_class: statusClass, le }, value }));

/** Every id of a side, each with the same answers: `requests` of them, most fast, `slow` of each hundred slower. */
function side(ids: readonly string[], requests: number, { errors = 0, slow = 0.5, tail = '0.3' } = {}): Sample[] {
  return ids.flatMap((id) => {
    const ok = requests * (1 - errors);
    const fast = ok * (1 - slow / 100);
    const bounds: [string, number][] = [
      ['0.1', fast],
      ['0.2', fast],
      ['0.3', tail === '0.3' ? ok : fast],
      ['0.5', ok],
      ['+Inf', ok],
    ];
    return [
      ...series(id, '2xx', bounds),
      ...(errors
        ? series(id, '5xx', [
            ['0.1', requests * errors],
            ['+Inf', requests * errors],
          ])
        : []),
    ];
  });
}

describe('each side’s figures', () => {
  const sides: Sides = { on: ['traffic-000', 'traffic-001'], off: ['traffic-002'] };

  it('takes requests from +Inf, errors from 5xx and no answer, and leaves out an id on neither side', () => {
    const samples = [
      ...series('traffic-000', '2xx', [
        ['0.1', 90],
        ['+Inf', 90],
      ]),
      ...series('traffic-000', '5xx', [
        ['0.1', 6],
        ['+Inf', 6],
      ]),
      ...series('traffic-001', 'none', [
        ['10', 0],
        ['+Inf', 4],
      ]),
      ...series('traffic-002', '3xx', [
        ['0.1', 50],
        ['+Inf', 50],
      ]),
      ...series('somebody', '5xx', [
        ['0.1', 1000],
        ['+Inf', 1000],
      ]),
    ];
    const { on, off } = figuresOf(samples, sides);
    expect(on).toMatchObject({ requests: 100, errorRate: 0.1 });
    expect(off).toMatchObject({ requests: 50, errorRate: 0 });
  });

  it('sums the pieces of the window bucket by bucket before it interpolates, as one range would', () => {
    const piece = series('traffic-002', '2xx', [
      ['0.1', 50],
      ['0.2', 99],
      ['+Inf', 100],
    ]);
    const { off } = figuresOf([...piece, ...piece], sides);
    expect(off.requests).toBe(200);
    expect(off.p99Ms).toBe(
      (quantile(
        0.99,
        new Map([
          [0.1, 100],
          [0.2, 198],
          [Infinity, 200],
        ]),
      ) as number) * 1000,
    );
  });

  it('has no rate and no tail for a side with no requests: an empty answer', () => {
    expect(figuresOf([], sides).on).toEqual({ requests: 0, errorRate: null, p99Ms: null, p99Seconds: null });
  });

  it('rounds the requests an increase extrapolates', () => {
    const { off } = figuresOf(
      series('traffic-002', '2xx', [
        ['0.1', 99.6],
        ['+Inf', 99.6],
      ]),
      sides,
    );
    expect(off.requests).toBe(100);
  });
});

describe('the quantile, as histogram_quantile interpolates it', () => {
  const buckets = (...pairs: [number, number][]) => new Map(pairs);

  it('interpolates inside the bucket the rank falls in', () => {
    // 100 requests, 99 under 0.2 s and 50 under 0.1 s: the 99th is at the top of the second bucket.
    expect(quantile(0.99, buckets([0.1, 50], [0.2, 99], [Infinity, 100]))).toBeCloseTo(0.2);
    expect(quantile(0.5, buckets([0.1, 50], [0.2, 99], [Infinity, 100]))).toBeCloseTo(0.1);
    expect(quantile(0.75, buckets([0.1, 50], [0.2, 100], [Infinity, 100]))).toBeCloseTo(0.15);
  });

  it('takes the first bucket from nought', () => {
    expect(quantile(0.5, buckets([0.1, 100], [Infinity, 100]))).toBeCloseTo(0.05);
  });

  it('answers the highest finite bound when the rank falls in +Inf', () => {
    expect(quantile(0.99, buckets([0.1, 50], [10, 90], [Infinity, 100]))).toBe(10);
  });

  it('evens out a bucket below the one before it, as an increase over a restart can leave one', () => {
    expect(quantile(0.99, buckets([0.1, 60], [0.2, 59.5], [Infinity, 60]))).toBeCloseTo(0.1 * (59.4 / 60));
  });

  it('has none with no requests, or no +Inf', () => {
    expect(quantile(0.99, buckets([0.1, 0], [Infinity, 0]))).toBeNull();
    expect(quantile(0.99, buckets([0.1, 5], [0.2, 5]))).toBeNull();
  });
});

describe('the question to Prometheus', () => {
  it('asks for the increase of each id’s buckets over the piece, so a generator restart is counted across', () => {
    expect(figuresQuery(600)).toBe(
      'sum by (share_id, status_class, le) (increase(factory_traffic_request_duration_seconds_bucket' +
        '{job="software-factory/traffic", share_id!="none"}[600s]))',
    );
  });
});

describe('the judgement, flag on as the canary and flag off as its baseline', () => {
  const sides = sidesOf('gift-note', 50);
  const window = release.flags.windowMinutes * 60_000;
  const judged = (on: Sample[], off: Sample[], ms = window) => {
    const figures = figuresOf([...on, ...off], sides);
    return judge(figures.on, figures.off, ms);
  };

  it('passes an even split', () => {
    expect(judged(side(sides.on, 40), side(sides.off, 40))).toEqual({ kind: 'judged', outcome: 'passed' });
  });

  it('fails a side with more errors, a point and more above the other', () => {
    expect(judged(side(sides.on, 40, { errors: 0.05 }), side(sides.off, 40, { errors: 0.01 }))).toEqual({
      kind: 'judged',
      outcome: 'failed',
      reason: 'Errors 5.00% with the flag on against 1.00% off',
    });
    // Within a point passes.
    expect(judged(side(sides.on, 40, { errors: 0.015 }), side(sides.off, 40, { errors: 0.01 }))).toMatchObject({
      outcome: 'passed',
    });
  });

  it('fails a slower tail', () => {
    // A tenth of the requests at up to half a second, against a two-hundredth: the 99th percentile is far slower.
    expect(judged(side(sides.on, 40, { slow: 10, tail: '0.5' }), side(sides.off, 40))).toMatchObject({
      kind: 'judged',
      outcome: 'failed',
      reason: expect.stringMatching(/^P99 \d+ ms with the flag on against \d+ ms off$/),
    });
  });

  it('passes a fast route a little slower, by the canary’s minimum seconds', () => {
    // Off's tail is 100 ms; on's 180 ms is 80% slower, but under 100 ms more.
    const fast = (ids: readonly string[], at: string) =>
      ids.flatMap((id) =>
        series(id, '2xx', [
          [at, 40],
          ['+Inf', 40],
        ]),
      );
    const figures = figuresOf([...fast(sides.on, '0.18'), ...fast(sides.off, '0.1')], sides);
    expect(figures.on.p99Seconds).toBeGreaterThan((figures.off.p99Seconds as number) * 1.25);
    expect(judge(figures.on, figures.off, window)).toEqual({ kind: 'judged', outcome: 'passed' });
  });

  it('waits with too few requests on either side', () => {
    const few = release.minRequests / sides.off.length / 2;
    expect(judged(side(sides.on, 40), side(sides.off, few))).toMatchObject({
      kind: 'wait',
      why: expect.stringContaining(`of the ${release.minRequests} each side needs`),
    });
  });

  it('waits on an empty answer', () => {
    expect(judged([], [])).toMatchObject({ kind: 'wait' });
  });

  it('waits until the window, less what was set aside, is long enough', () => {
    expect(judged(side(sides.on, 40), side(sides.off, 40), window - 1000)).toMatchObject({
      kind: 'wait',
      why: expect.stringContaining(`of the ${release.flags.windowMinutes} minutes the window needs`),
    });
  });
});
