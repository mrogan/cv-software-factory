/**
 * OpenTelemetry for the gateway: traces, metrics and logs, sent over OTLP to the collector, as for the console.
 *
 * Load it before the server's modules, so the instrumentation is in place before they import what it patches:
 * `factory gateway` imports it first, and `node --import` does the same. Configured by the standard OTEL_*
 * environment variables; the endpoint defaults to http://localhost:4318.
 */
import { register } from 'node:module';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NodeSDK } from '@opentelemetry/sdk-node';

// ES modules are patched through a loader hook, which has to be registered before they are imported.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'gateway',
  // Probes hit /health every few seconds; a span for each would bury the calls that matter.
  instrumentations: [
    new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/health' }),
    new PinoInstrumentation(),
  ],
});
sdk.start();

/** Flushes whatever is buffered. Call it once, as the process stops. */
export function shutdownTelemetry(): Promise<void> {
  return sdk.shutdown();
}
