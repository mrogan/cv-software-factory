/**
 * OpenTelemetry for the factory's workers: traces, metrics and logs, sent over OTLP to the collector, as for the
 * console. Each worker names itself with OTEL_SERVICE_NAME, or by its command.
 *
 * Load it before the worker's modules, so the instrumentation is in place before they import what it patches: each
 * `factory` command that runs a worker imports it first. Configured by the standard OTEL_*
 * environment variables; the endpoint defaults to http://localhost:4318.
 */
import { register } from 'node:module';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { NodeSDK } from '@opentelemetry/sdk-node';

// ES modules are patched through a loader hook, which has to be registered before they are imported.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? `factory-${process.argv[2] ?? 'command'}`,
  // Kubernetes probes /health every few seconds; a span for each would bury the requests that matter.
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
