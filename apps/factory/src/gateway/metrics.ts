/**
 * The gateway's OpenTelemetry metrics. Until `telemetry.ts` starts an SDK these are no-ops, so tests and the
 * in-process gateway need none. Attributes are agent, provider, model and outcome, as the `model call` span names
 * them (`spans.ts`), and a few closed sets beside them (a token's kind, a provider's status, a cap): never a work
 * item, which would make a series for each, and never anything from a request.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import type { Profile } from '../../../../policy/spend.ts';

const meter = metrics.getMeter('factory-gateway');

export const calls = meter.createCounter('gateway.calls', {
  description: 'Calls to the gateway, by agent, provider, model and outcome (answered, replayed, refused, failed)',
});

/**
 * Every priced call's cost, a judgement's or an agent's, as the gateway counts it, whatever event records it: the
 * factory's dashboard reads it as `factory_gateway_spend_usd_total` (`deploy/base/telemetry/dashboards/factory.json`).
 */
export const SPEND_METRIC = 'factory_gateway_spend_usd';

export const spend = meter.createCounter(SPEND_METRIC, {
  description: 'Model spend counted by the gateway, in US dollars',
});

export const latency = meter.createHistogram('gateway.call.duration', {
  description: 'How long a call took, a replay included',
  unit: 'ms',
});

/** What a token was spent on, as the span's `input_tokens`, `output_tokens`, `cache_read_tokens` and `cache_write_tokens`. */
export type TokenKind = 'input' | 'output' | 'cache_read' | 'cache_write';

/**
 * Tokens, as the audit row counts them: an answered call's, a failed call's that the provider billed (a stream that
 * broke off), and a replay's as its cassette recorded them, which cost nothing. `outcome` tells them apart. A kind
 * a call used none of is not counted.
 */
export const tokens = meter.createCounter('gateway.tokens', {
  description:
    'Tokens in calls the gateway took, by agent, provider, model, outcome and kind (input, output, cache_read, cache_write)',
});

/**
 * A provider that answered with an error, or not at all: `status` is the HTTP status it answered (`429`, `529`, a
 * refusal for spent credit's `400`), or what happened instead: `network` (it could not be reached), `timeout`,
 * `malformed` (it answered with something other than an answer), or `broken` (a stream that reported an error or
 * broke off). Each failed attempt counts, TypeSafe's retried ones included. A runner that goes away is not the
 * provider's error, nor a cassette that no longer reads, and neither is counted.
 */
export const providerErrors = meter.createCounter('gateway.provider.errors', {
  description: 'Errors from a model provider, by agent, provider, model and status',
});

/**
 * Calls refused because a cap was reached, before anything was sent: `cap` is `day`, `month` or `work-item` (the
 * factory's own, `policy/spend.ts`), or `provider` (one it does not own: spent credit, a workspace's limit, or the
 * local model not listening, `provider-caps.ts`). A refusal for no cassette, or for a request the gateway will not
 * send, is only an `outcome` on `gateway.calls`.
 */
export const capRefusals = meter.createCounter('gateway.cap.refusals', {
  description: 'Calls refused for a spend cap, by agent, provider, model and cap (day, month, work-item, provider)',
});

const capSpent = meter.createObservableGauge('gateway.cap.spent_usd', {
  description: "Model spend so far in the day's and the month's window, by cap (day, month) and profile, in US dollars",
});

const capLimit = meter.createObservableGauge('gateway.cap.limit_usd', {
  description: "The profile's spend caps, by cap (day, month, work-item) and profile, in US dollars",
});

/** The spend against the profile's caps, as `Spend` last counted it. */
export interface CapReading {
  profile: Profile;
  dayUsd: number;
  monthUsd: number;
  limits: { dayUsd: number; monthUsd: number | null; workItemUsd: number };
}

/**
 * Reports spend against the caps whenever metrics are collected, from `read`, which gives nothing until it knows.
 * One series a cap, never one a work item: a work item's cap is reported, and what each spends is the audit log's.
 * Returns what stops it.
 */
export function observeCaps(read: () => CapReading | undefined): () => void {
  const observe = (result: BatchObservableResult) => {
    const reading = read();
    if (!reading) return;
    const { profile, limits } = reading;
    result.observe(capSpent, reading.dayUsd, { cap: 'day', profile });
    result.observe(capSpent, reading.monthUsd, { cap: 'month', profile });
    result.observe(capLimit, limits.dayUsd, { cap: 'day', profile });
    if (limits.monthUsd !== null) result.observe(capLimit, limits.monthUsd, { cap: 'month', profile });
    result.observe(capLimit, limits.workItemUsd, { cap: 'work-item', profile });
  };
  meter.addBatchObservableCallback(observe, [capSpent, capLimit]);
  return () => meter.removeBatchObservableCallback(observe, [capSpent, capLimit]);
}
