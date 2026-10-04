/**
 * What each pinned model costs, in US dollars per million tokens. Spend is counted from these, so a model with no
 * price is refused rather than called for free: the caps could not hold.
 *
 * Claude's prompt cache is priced apart from fresh input: a read at a fraction of it, and a write at 1.25 times it
 * for five minutes or twice it for an hour (Anthropic's prices, October 2026). A local model costs nothing, and is
 * listed so that a call to it is still known, counted and capped.
 */
import { BadRequest } from './errors.ts';

export interface Price {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion?: number;
  /** A cache write that lives five minutes, the default. */
  cacheWritePerMillion?: number;
  /** A cache write that lives an hour. */
  cacheWriteHourPerMillion?: number;
}

const claude = (input: number, output: number, cacheRead: number): Price => ({
  inputPerMillion: input,
  outputPerMillion: output,
  cacheReadPerMillion: cacheRead,
  cacheWritePerMillion: input * 1.25,
  cacheWriteHourPerMillion: input * 2,
});

const FREE: Price = { inputPerMillion: 0, outputPerMillion: 0 };

export const PRICES: Readonly<Record<string, Price>> = {
  // Output tokens are free for now (TypeSafe's OpenAPI document says so).
  'jev-1.13.0': { inputPerMillion: 0.042, outputPerMillion: 0 },
  'claude-opus-5-5': claude(4, 20, 0.2),
  'claude-sonnet-5-5': claude(2, 10, 0.2),
  'claude-haiku-4-5': claude(1, 5, 0.1),
  // LM Studio on Martin's Mac.
  'qwen/qwen3.8-27b': FREE,
};

export function priceOf(model: string): Price {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) throw new BadRequest(`Model ${model} has no price in the gateway, so its spend could not be counted.`);
  return price;
}

export interface Usage {
  /** Input read fresh: not from the cache, and not written to it. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  /** Input written to the cache for five minutes. */
  cacheWriteTokens?: number;
  /** Input written to the cache for an hour. */
  cacheWriteHourTokens?: number;
}

/** What a call cost. */
export function costOf(model: string, usage: Usage): number {
  const price = priceOf(model);
  const part = (tokens = 0, perMillion = price.inputPerMillion) => tokens * perMillion;
  return (
    (part(usage.inputTokens) +
      part(usage.outputTokens, price.outputPerMillion) +
      part(usage.cacheReadTokens, price.cacheReadPerMillion) +
      part(usage.cacheWriteTokens, price.cacheWritePerMillion) +
      part(usage.cacheWriteHourTokens, price.cacheWriteHourPerMillion)) /
    1_000_000
  );
}
