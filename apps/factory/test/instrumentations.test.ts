/**
 * The workers' instrumentation of requests out, as `telemetry.ts` installs it, with an in-memory exporter in place of
 * the collector and a server that says what headers it was sent.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { SpanKind } from '@opentelemetry/api';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { listenLocal } from '@software-factory/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { instrumentations } from '../src/instrumentations.ts';
import { recordSpans } from './tracing.ts';

const { tracer, spans } = recordSpans();

let heard: IncomingHttpHeaders[] = [];
const server = createServer((req, res) => {
  heard.push(req.headers);
  res.end('ok');
});
let base = '';

beforeAll(async () => {
  base = (await listenLocal(server)).url;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  heard = [];
});

const clientSpans = () => spans().filter((span) => span.kind === SpanKind.CLIENT);

describe('a worker’s requests out through node:http', () => {
  it('make a span only inside one, as fetch does', () => {
    const all = instrumentations();
    for (const each of all) each.disable();
    const http = all.find((each) => each instanceof HttpInstrumentation);
    expect(http?.getConfig()).toMatchObject({ requireParentforOutgoingSpans: true });
  });
});

describe('a worker’s fetch', () => {
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

    expect(spans()).toEqual([]);
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
