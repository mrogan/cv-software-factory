/**
 * What the gateway counts a call as costing (`src/gateway/prices.ts`): fresh input, output and the cache at their own
 * rates, and a long prompt at its model's dearer rate where it has one; and the probe of a capped provider, priced by
 * the same table.
 */
import { describe, expect, it } from 'vitest';
import { costOf, PRICES, priceOf } from '../../src/gateway/prices.ts';
import { probeOf } from '../../src/gateway/service.ts';

describe('a call’s cost', () => {
  it('counts fresh input, output, cache reads and both cache writes, each at its rate', () => {
    // Claude Sonnet 5.5: $2 in, $10 out, $0.20 a cache read, $2.50 a five-minute write and $4 an hour's.
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheWriteHourTokens: 1_000_000,
    };
    expect(costOf('claude-sonnet-5-5', usage)).toBeCloseTo(2 + 10 + 0.2 + 2.5 + 4, 10);
  });

  it('prices Claude Haiku 5.5 at its rate up to a 100K-token prompt, and the whole call at five times it beyond', () => {
    const cost = (prompt: {
      inputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cacheWriteHourTokens?: number;
    }) => costOf('claude-haiku-5-5', { outputTokens: 1_000, ...prompt });
    // $0.10 in and $0.50 out a million up to 100K tokens of prompt.
    expect(cost({ inputTokens: 100_000 })).toBeCloseTo((100_000 * 0.1 + 1_000 * 0.5) / 1e6, 12);
    // Over it, $0.50 and $2.50, output included.
    expect(cost({ inputTokens: 100_001 })).toBeCloseTo((100_001 * 0.5 + 1_000 * 2.5) / 1e6, 12);
    // The prompt counts what is read from the cache and written to it, each then at the long rate's cache prices.
    expect(cost({ inputTokens: 1_000, cacheReadTokens: 90_000, cacheWriteTokens: 9_000 })).toBeCloseTo(
      (1_000 * 0.1 + 90_000 * 0.01 + 9_000 * 0.125 + 1_000 * 0.5) / 1e6,
      12,
    );
    expect(cost({ inputTokens: 1_000, cacheReadTokens: 90_000, cacheWriteTokens: 10_000 })).toBeCloseTo(
      (1_000 * 0.5 + 90_000 * 0.05 + 10_000 * 0.625 + 1_000 * 2.5) / 1e6,
      12,
    );
    // An hour's cache write counts too: here it alone takes the prompt over.
    expect(cost({ inputTokens: 100_000, cacheWriteHourTokens: 1 })).toBeCloseTo(
      (100_000 * 0.5 + 1 * 1 + 1_000 * 2.5) / 1e6,
      12,
    );
  });

  it('has no price for Claude Haiku 4.5, which no profile offers, so a call to it is refused', () => {
    expect(Object.hasOwn(PRICES, 'claude-haiku-4-5')).toBe(false);
    expect(() => priceOf('claude-haiku-4-5')).toThrow(/no price/);
  });
});

describe('the probe of a capped provider', () => {
  it('asks the cheapest model the profile offers there for one token, with no thinking to spend it on', () => {
    expect(probeOf('local', 'anthropic')).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 1,
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'Reply with one word.' }],
    });
    expect(probeOf('do', 'anthropic')?.model).toBe('claude-haiku-5-5');
    expect(probeOf('local', 'local')?.model).toBe('qwen/qwen3.8-27b');
    // A profile with no local model has nothing to ask there.
    expect(probeOf('do', 'local')).toBeUndefined();
    for (const name of ['anthropic', 'local'] as const) {
      const model = probeOf('local', name)?.model;
      if (model) expect(() => priceOf(model)).not.toThrow();
    }
  });
});
