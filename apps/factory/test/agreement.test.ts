import { describe, expect, it } from 'vitest';
import { agree, combine, judge, type RouteCounts, requestsBetween, TOLERANCE } from '../src/logs/agreement.ts';
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

const entry = (path: string, metrics: number, logs: number, traces?: number): RouteCounts => ({
  path,
  route: path,
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
  it('takes the counter now less the counter then, counting a series born in the window from nothing', () => {
    const expr = requestsBetween('job="app"', 300);
    expect(expr).toContain('offset 300s');
    // The series that did not exist then falls back to itself times zero.
    expect(expr).toMatch(/ or sum by .* \* 0\), 0\)$/);
    expect(expr.startsWith('clamp_min(')).toBe(true);
  });
});
