/**
 * OpenTelemetry for the console: traces, metrics and logs, sent over OTLP to the collector.
 *
 * Preloaded with `node --import ./src/telemetry.ts`, so the instrumentation is in place before the server imports
 * the modules it patches. Configured by the standard OTEL_* environment variables; the endpoint defaults to
 * http://localhost:4318, which `pnpm dev` reaches through a port-forward to the cluster's collector.
 */
import { register } from 'node:module';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NodeSDK } from '@opentelemetry/sdk-node';

// ES modules are patched through a loader hook, which has to be registered before they are imported.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'console',
  instrumentations: [
    // Probes hit /health every few seconds; a span for each would bury the requests that matter.
    new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/health' }),
    new PinoInstrumentation(),
  ],
});
sdk.start();

/** Flushes whatever is buffered. Call it once, as the process stops. */
export function shutdownTelemetry(): Promise<void> {
  return sdk.shutdown();
}
