/**
 * OpenTelemetry for the factory's workers: traces, metrics and logs, sent over OTLP to the collector, as for the
 * console. Each worker names itself with OTEL_SERVICE_NAME, or by its command, and reports its own health: its heap,
 * its event loop's delay and use, and its garbage collection.
 *
 * Load it before the worker's modules, so the instrumentation is in place before they import what it patches: each
 * `factory` command that runs a worker imports it first. Configured by the standard OTEL_*
 * environment variables; the endpoint defaults to http://localhost:4318.
 */
import { register } from 'node:module';
import { RuntimeNodeInstrumentation } from '@opentelemetry/instrumentation-runtime-node';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { instrumentations } from './instrumentations.ts';

// ES modules are patched through a loader hook, which has to be registered before they are imported.
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? `factory-${process.argv[2] ?? 'command'}`,
  // The runtime's series are metrics alone, kept apart from what `instrumentations()` traces. Their attributes are the
  // runtime's own few values (a heap space, a kind of collection, an event loop state, a kind of handle).
  instrumentations: [...instrumentations(), new RuntimeNodeInstrumentation()],
});
sdk.start();

/** Flushes whatever is buffered. Call it once, as the process stops. */
export function shutdownTelemetry(): Promise<void> {
  return sdk.shutdown();
}
