/**
 * The gateway's OpenTelemetry metrics. Until `telemetry.ts` starts an SDK these are no-ops, so tests and the
 * in-process gateway need none. Attributes are agent, provider, model and outcome: never a work item, which would
 * make a series for each, and never anything from a request.
 */
import { metrics } from '@opentelemetry/api';

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
