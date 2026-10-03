import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { type Backends, parse, signalFor } from '../src/intake/alerts.ts';
import { createIntake } from '../src/intake/server.ts';
import type { Outbox } from '../src/outbox.ts';
import { fakeFetch, matrix, ns, streams, VERSION, vector } from './fakes.ts';

const NOW = new Date('2026-10-03T21:00:00Z');

const errorAlert = {
  status: 'firing',
  labels: {
    alertname: 'RouteErrorRatioAboveObjective',
    route: '/products/glove-left',
    http_route: '/products/glove-left',
    symptom: 'server-error',
    objective: 'error-ratio',
  },
  annotations: { threshold: '0.05' },
  startsAt: '2026-10-03T20:40:00Z',
};
const webhook = (...alerts: unknown[]) => ({ version: '4', status: 'firing', alerts });
function alertOf(alert: unknown) {
  const [parsed] = parse(webhook(alert));
  if (!parsed) throw new Error('the test alert did not parse');
  return parsed;
}

function backends(seen: URL[] = [], overrides: { versions?: unknown; failPrometheus?: boolean } = {}): Backends {
  const points: [number, number][] = Array.from({ length: 61 }, (_, i) => [
    NOW.getTime() / 1000 - 3600 + i * 60,
    i < 40 ? 0.01 : 0.2,
  ]);
  const prometheus = fakeFetch(
    [
      {
        path: '/api/v1/query_range',
        answer: () => {
          if (overrides.failPrometheus) throw new Error('Prometheus is down');
          return matrix(points);
        },
      },
      { path: '/api/v1/query', answer: () => overrides.versions ?? vector([{ service_version: VERSION }, 30]) },
    ],
    seen,
  );
  const loki = fakeFetch(
    [
      {
        path: '/loki/api/v1/query_range',
        answer: () =>
          streams([
            ns('2026-10-03T20:50:00Z'),
            'GET /products/glove-left 200',
            { path: '/products/glove-left', route: '/products/:slug' },
          ]),
      },
    ],
    seen,
  );
  return {
    objectives,
    prometheus: new Prometheus('http://prometheus', prometheus),
    loki: new Loki('http://loki', loki),
    now: () => NOW,
  };
}

describe('the intake, from an alert to a signal', () => {
  it('makes a metrics signal of an error-ratio alert, with the series behind it', async () => {
    const seen: URL[] = [];
    const alert = alertOf(errorAlert);
    const signal = await signalFor(alert, backends(seen));

    expect(signal).toMatchObject({
      sense: 'metrics',
      check: 'error ratio',
      // The metrics know the path; the log knows the route it was served by.
      route: '/products/:slug',
      version: VERSION,
      symptom: 'server-error',
      observedAt: NOW.toISOString(),
    });
    expect(validateSignal(signal)).toEqual({ ok: true });

    const [picture] = signal.evidence ?? [];
    expect(picture).toMatchObject({
      kind: 'metric',
      unit: 'ratio',
      objective: 0.05,
      stepSeconds: 60,
      start: '2026-10-03T20:00:00.000Z',
      marker: { index: 40, label: 'alert fired' },
    });
    expect(picture?.kind === 'metric' && picture.values).toHaveLength(61);
    expect(picture?.kind === 'metric' && picture.values[45]).toBeCloseTo(0.2);

    // The series asked for is the objective's, for that route and no other.
    const asked = seen.find((url) => url.pathname === '/api/v1/query_range')?.searchParams.get('query');
    expect(asked).toContain('http_route="/products/glove-left"');
    expect(asked).toContain('5..');
  });

  it('makes a slow-response signal of a latency alert, in seconds', async () => {
    const alert = alertOf({
      ...errorAlert,
      labels: { ...errorAlert.labels, symptom: 'slow-response', objective: 'latency' },
      annotations: { threshold: '1' },
    });
    const signal = await signalFor(alert, backends());
    expect(signal).toMatchObject({ check: 'latency p95', symptom: 'slow-response' });
    expect(signal.evidence?.[0]).toMatchObject({ kind: 'metric', unit: 's', objective: 1, name: 'p95 latency' });
  });

  it('falls back to the path when the log does not know the route', async () => {
    const empty = backends();
    empty.loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: () => streams() }]));
    const alert = alertOf(errorAlert);
    expect((await signalFor(alert, empty)).route).toBe('/products/glove-left');
  });

  it('refuses an alert whose symptom the factory does not know, and one for an objective it lacks', async () => {
    const bad = alertOf({ ...errorAlert, labels: { ...errorAlert.labels, symptom: 'on-fire' } });
    await expect(signalFor(bad, backends())).rejects.toThrow('symptom class the factory lacks');
    const other = alertOf({ ...errorAlert, labels: { ...errorAlert.labels, objective: 'happiness' } });
    await expect(signalFor(other, backends())).rejects.toThrow('objective the factory does not know');
  });

  it('will not guess the version', async () => {
    const alert = alertOf(errorAlert);
    await expect(signalFor(alert, backends([], { versions: vector() }))).rejects.toThrow('no version');
  });
});

describe('the intake, over HTTP', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function post(body: unknown, options: { backends?: Backends; sent?: InboxSignal[] } = {}) {
    const sent = options.sent ?? [];
    const outbox: Outbox = { send: async (signal) => void sent.push(signal) };
    server = createServer(
      createIntake({ backends: options.backends ?? backends(), outbox, log: pino({ level: 'silent' }) }),
    );
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://localhost:${port}/v1/alerts`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  it('leaves one signal for each firing alert, and none for a resolved one', async () => {
    const sent: InboxSignal[] = [];
    const answer = await post(
      webhook(errorAlert, { ...errorAlert, status: 'resolved' }, { ...errorAlert, labels: { ...errorAlert.labels } }),
      { sent },
    );
    expect(answer).toEqual({ status: 200, body: { accepted: 2, refused: 0, failed: 0 } });
    expect(sent).toHaveLength(2);
  });

  it('answers 400 to what is not a webhook, so that nobody sends it again', async () => {
    expect((await post('{nope')).status).toBe(400);
    expect((await post({ alerts: 'many' })).status).toBe(400);
  });

  it('answers 422 to an alert that can never be a signal', async () => {
    const answer = await post(webhook({ ...errorAlert, labels: { route: '/x' } }));
    expect(answer).toEqual({ status: 422, body: { accepted: 0, refused: 1, failed: 0 } });
  });

  it('answers 503 when a backend fails, so that Alertmanager tries again', async () => {
    const answer = await post(webhook(errorAlert), { backends: backends([], { failPrometheus: true }) });
    expect(answer).toEqual({ status: 503, body: { accepted: 0, refused: 0, failed: 1 } });
  });

  it('answers a health check', async () => {
    server = createServer(
      createIntake({ backends: backends(), outbox: { send: async () => {} }, log: pino({ level: 'silent' }) }),
    );
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    expect((await fetch(`http://localhost:${port}/health`)).status).toBe(200);
  });
});
