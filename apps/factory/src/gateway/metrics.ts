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

export const spend = meter.createCounter('gateway.spend', {
  description: 'Model spend counted by the gateway',
  unit: 'USD',
});

export const latency = meter.createHistogram('gateway.call.duration', {
  description: 'How long a call took, a replay included',
  unit: 'ms',
});
