/**
 * OpenTelemetry for the console: traces, metrics and logs, sent over OTLP to the collector, its runtime's health
 * among the metrics.
 *
 * Preloaded with `node --import ./src/telemetry.ts`, so the instrumentation is in place before the server imports
 * the modules it patches. Configured by the standard OTEL_* environment variables; the endpoint defaults to
 * http://localhost:4318, which `pnpm dev` reaches through a port-forward to the cluster's collector.
 */
import { register } from 'node:module';
import { metrics } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { NodeSDK } from '@opentelemetry/sdk-node';

// ES modules are patched through a loader hook, which has to be registered before they are imported.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'console',
  instrumentations: [
    // Probes hit /health every few seconds; a span for each would bury the requests that matter. An event stream
    // stays open for as long as a browser does, so it would read as one very slow request: it has metrics of its
    // own (stream.ts).
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (req) => req.url === '/health' || Boolean(req.url?.startsWith('/api/events/stream')),
    }),
    new PinoInstrumentation(),
    // Its heap, its event loop's delay and use, and its garbage collection, as the factory's workers report theirs.
    new RuntimeNodeInstrumentation(),
  ],
});
sdk.start();

/** Flushes whatever is buffered. Call it once, as the process stops. */
export function shutdownTelemetry(): Promise<void> {
  return sdk.shutdown();
}

/**
 * Sends the metrics as they stand, before the server takes its first request: a count started at 0 has to reach
 * Prometheus as 0 before its first event does, or its first sample is that event, which `rate` and `increase` read
 * nothing into. Waits at most five seconds, so a collector that is down holds up nothing.
 */
export async function sendMetrics(): Promise<void> {
  const provider = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    provider.forceFlush?.().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 5_000);
    }),
  ]);
  clearTimeout(timer);
}
