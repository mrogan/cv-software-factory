import { describe, expect, it } from 'vitest';
import { axis, figure, isCommit, shortVersion } from '../web/src/format.ts';

describe('a chart’s axis', () => {
  it.each([
    ['latency in milliseconds', 706, 800, [0, 400, 800]],
    ['an error rate', 0.03, 0.04, [0, 0.02, 0.04]],
    ['a latency in seconds', 0.8, 0.9, [0, 0.45, 0.9]],
    ['a share just under a whole', 0.27, 0.3, [0, 0.15, 0.3]],
    ['nothing at all', 0, 1, [0, 0.5, 1]],
  ])('fits %s', (_case, top, max, ticks) => {
    expect(axis(top)).toEqual({ max, ticks });
  });

  it('gives every tick its own value and label', () => {
    for (const top of [0.003, 0.03, 0.3, 3, 30, 300, 3000]) {
      const { ticks } = axis(top);
      expect(new Set(ticks.map(figure)).size).toBe(3);
    }
  });
});

describe('a figure', () => {
  it('keeps three significant figures, whatever the scale', () => {
    expect([642, 85, 0.015, 0.02345, 1500].map(figure)).toEqual(['642', '85', '0.015', '0.0235', '1,500']);
  });
});

describe('a version', () => {
  it('writes a commit by its first seven characters, as GitHub does', () => {
    expect(shortVersion('4f9c2e1b7d3a6058e9b1c4d2a7f3e6b9c0d1e2f3')).toBe('4f9c2e1');
    expect(shortVersion('4f9c2e1')).toBe('4f9c2e1');
  });

  it('writes a release as it is', () => {
    expect(shortVersion('v0.9.3')).toBe('v0.9.3');
    expect(isCommit('v0.9.3')).toBe(false);
  });
});
