/**
 * The probes' checks of whether the console and the app answer: the addresses read from the profile's HEALTH_CHECKS,
 * each check's outcome, and the counts the alerts read, every one from 0, as an OpenTelemetry SDK collects them.
 */
import { createServer } from 'node:http';
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { listenLocal } from '@software-factory/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { manifests } from '../deploy.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
// Only now: the module takes its meter as it loads.
const { check, healthChecks, startHealthChecks } = await import('../../src/probes/health.ts');

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

async function counts(): Promise<{ attributes: Record<string, unknown>; value: number }[]> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === 'probes.checks');
  return (metric?.dataPoints ?? []).map((p) => ({ attributes: p.attributes, value: p.value as number }));
}

/** A server that answers each path with the status given, and records the headers it was asked with. */
async function serving(statuses: Record<string, number>) {
  const asked: Record<string, string | undefined>[] = [];
  const server = createServer((req, res) => {
    asked.push({ unmeasured: req.headers['x-unmeasured'] as string | undefined });
    const status = statuses[req.url ?? ''];
    if (status === undefined) {
      req.socket.destroy();
      return;
    }
    res.writeHead(status).end('ok');
  });
  const { url } = await listenLocal(server);
  return { url, asked, close: () => new Promise((resolve) => server.close(resolve)) };
}

describe('the probes’ checks of who answers', () => {
  it('read the profile’s addresses, by target, and refuse anything else', () => {
    expect(healthChecks('console=http://console/health  app=http://website.website/health')).toEqual([
      { target: 'console', url: 'http://console/health', address: 'http://console' },
      { target: 'app', url: 'http://website.website/health', address: 'http://website.website' },
    ]);
    expect(healthChecks(undefined)).toEqual([]);
    expect(healthChecks('')).toEqual([]);
    expect(() => healthChecks('shop=http://website.website/health')).toThrow(/console or app/);
    expect(() => healthChecks('console')).toThrow(/console or app/);
    expect(() => healthChecks('console=not an address')).toThrow(/not an address/);
    expect(() => healthChecks('console=file:///etc/passwd')).toThrow(/http or https/);
  });

  it('are the profile’s: the console’s and the app’s Services, from inside the cluster', async () => {
    type Deployment = {
      kind: string;
      metadata: { name: string };
      spec: { template: { spec: { containers: { env: { name: string; value?: string }[] }[] } } };
    };
    const probes = (await manifests<Deployment>()).find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata.name === 'probes',
    )?.manifest;
    const env = probes?.spec.template.spec.containers[0]?.env ?? [];
    const value = env.find((e) => e.name === 'HEALTH_CHECKS')?.value;
    expect(healthChecks(value).map(({ target, address }) => `${target} ${address}`)).toEqual([
      'console http://console',
      'app http://website.website',
    ]);
  });

  it('answer for a 2xx status, and fail for any other, a redirect, or no answer, never counting as a visit', async () => {
    const site = await serving({ '/health': 200, '/broken': 503, '/moved': 302 });
    try {
      expect(await check(`${site.url}/health`)).toBe('answered');
      expect(await check(`${site.url}/broken`)).toBe('failed');
      expect(await check(`${site.url}/moved`)).toBe('failed');
      expect(await check(`${site.url}/gone`)).toBe('failed');
      expect(await check('http://127.0.0.1:1/health')).toBe('failed');
      expect(site.asked.every((headers) => headers.unmeasured === '1')).toBe(true);
    } finally {
      await site.close();
    }
  });

  it('count each check by target, address and outcome, every count from 0', async () => {
    const site = await serving({ '/health': 200 });
    const list = healthChecks(`console=${site.url}/health app=${site.url}/down`);
    const stop = startHealthChecks(list, { every: 3_600_000 });
    await stop();
    await site.close();
    const all = await counts();
    const of = (target: string, outcome: string) =>
      all.find(
        (p) => p.attributes.target === target && p.attributes.outcome === outcome && p.attributes.address === site.url,
      )?.value;
    expect(of('console', 'answered')).toBe(1);
    expect(of('console', 'failed')).toBe(0);
    expect(of('app', 'answered')).toBe(0);
    expect(of('app', 'failed')).toBe(1);
  });
});
