/**
 * What each pinned model costs, in US dollars per million tokens. Spend is counted from these, so a model with no
 * price is refused rather than called for free: the caps could not hold.
 */
import { BadRequest } from './errors.ts';

export interface Price {
  inputPerMillion: number;
  outputPerMillion: number;
}

export const PRICES: Readonly<Record<string, Price>> = {
  // Output tokens are free for now (TypeSafe's OpenAPI document says so).
  'jev-1.13.0': { inputPerMillion: 0.042, outputPerMillion: 0 },
};

export function priceOf(model: string): Price {
  const price = Object.hasOwn(PRICES, model) ? PRICES[model] : undefined;
  if (!price) throw new BadRequest(`Model ${model} has no price in the gateway, so its spend could not be counted.`);
  return price;
}

/** What a call cost. */
export function costOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const price = priceOf(model);
  return (usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000;
}
