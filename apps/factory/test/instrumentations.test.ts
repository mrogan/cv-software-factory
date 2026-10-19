/**
 * The workers' `fetch` instrumentation, as `telemetry.ts` installs it, with an in-memory exporter in place of the
 * collector and a server that says what headers it was sent.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { node, tracing } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instrumentations } from '../src/instrumentations.ts';

const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });
const undici = instrumentations().find((each) => each instanceof UndiciInstrumentation);
const tracer = provider.getTracer('test');

let heard: IncomingHttpHeaders[] = [];
const server = createServer((req, res) => {
  heard.push(req.headers);
  res.end('ok');
});
let base = '';

beforeAll(async () => {
  provider.register();
  undici?.setTracerProvider(provider);
  undici?.enable();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  undici?.disable();
  server.closeAllConnections();
  server.close();
  await provider.shutdown();
  trace.disable();
  context.disable();
  propagation.disable();
});
beforeEach(() => {
  exporter.reset();
  heard = [];
});

const clientSpans = () => exporter.getFinishedSpans().filter((span) => span.kind === SpanKind.CLIENT);

describe('a worker’s fetch', () => {
  it('is installed', () => {
    expect(undici).toBeDefined();
  });

  it('inside a span, makes a client span under it and sends its trace on', async () => {
    const parent = await tracer.startActiveSpan('request', async (span) => {
      await (await fetch(`${base}/v1/messages`, { method: 'POST', body: '{}' })).text();
      span.end();
      return span.spanContext();
    });

    const [call] = clientSpans();
    expect(call?.name).toBe('POST');
    expect(call?.parentSpanContext?.spanId).toBe(parent.spanId);
    expect(call?.spanContext().traceId).toBe(parent.traceId);
    expect(call?.attributes['url.full']).toBe(`${base}/v1/messages`);
    // The server is told the client span's context, so its own span joins the same trace.
    expect(heard[0]?.traceparent).toBe(`00-${parent.traceId}-${call?.spanContext().spanId}-01`);
  });

  it('outside any span, makes no span and sends no trace', async () => {
    await (await fetch(`${base}/health`)).text();

    expect(exporter.getFinishedSpans()).toEqual([]);
    expect(heard).toHaveLength(1);
    expect(heard[0]?.traceparent).toBeUndefined();
  });

  it('leaves out the release watch even inside a span', async () => {
    await tracer.startActiveSpan('release', async (span) => {
      await (await fetch(`${base}/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website`)).text();
      span.end();
    });

    expect(clientSpans()).toEqual([]);
    expect(heard[0]?.traceparent).toBeUndefined();
  });
});
