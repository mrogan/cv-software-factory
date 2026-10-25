/**
 * Spans kept in memory, in place of the collector: `recordSpans()` installs a tracer provider for the test file, with
 * the workers' instrumentation of requests out, and returns what it records. Vitest gives each file its own globals.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import * as tracing from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { instrumentations } from '../src/instrumentations.ts';

export function recordSpans() {
  const exporter = new tracing.InMemorySpanExporter();
  const provider = new tracing.TracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor({ exporter })] });
  const all = instrumentations();
  // Every one enables itself as it is made; only `fetch`'s, which needs no module patched, is kept on.
  for (const each of all) each.disable();
  const undici = all.find((each) => each instanceof UndiciInstrumentation);
  if (!undici) throw new Error('The workers do not instrument fetch.');
  if (!all.some((each) => each instanceof HttpInstrumentation)) throw new Error('The workers do not instrument http.');
  beforeAll(() => {
    // What NodeSDK registers in the workers: context kept across awaits, and W3C headers on requests out.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(
      new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
    );
    trace.setGlobalTracerProvider(provider);
    undici.setTracerProvider(provider);
    undici.enable();
  });
  afterAll(async () => {
    undici.disable();
    await provider.shutdown();
    trace.disable();
    context.disable();
    propagation.disable();
  });
  beforeEach(() => exporter.reset());
  return {
    undici,
    tracer: provider.getTracer('test'),
    /** The spans ended so far, named `name` if given. */
    spans: (name?: string) => exporter.getFinishedSpans().filter((span) => name === undefined || span.name === name),
  };
}
