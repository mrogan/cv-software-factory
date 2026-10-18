import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { environmentLook } from '../src/environment.ts';
import { DEPLOY } from './deploy.ts';
import { fakeFetch, vector } from './fakes.ts';

const at = new Date('2026-10-13T19:47:57.000Z');
const query = (text: string) => (url: URL) => url.searchParams.get('query') === text;
const volumes = 'bottomk(1, kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes)';

/** A cluster's backends, each answering as told. */
function backends(answers: { up?: unknown; otlp?: unknown; free?: unknown; records?: unknown; traces?: unknown[] }) {
  const seen: URL[] = [];
  const fetcher = fakeFetch(
    [
      { path: '/api/v1/query', when: query('up'), answer: () => answers.up ?? vector([{ job: 'prometheus' }, 1]) },
      { path: '/api/v1/query', when: query('count(target_info)'), answer: () => answers.otlp ?? vector([{}, 10]) },
      {
        path: '/api/v1/query',
        when: query(volumes),
        answer: () =>
          answers.free ?? vector([{ namespace: 'telemetry', persistentvolumeclaim: 'storage-loki-0' }, 0.94]),
      },
      { path: '/loki/api/v1/query', answer: () => answers.records ?? vector([{}, 1530]) },
      { path: '/api/search', answer: () => ({ traces: 'traces' in answers ? answers.traces : [{ traceID: 'a' }] }) },
    ],
    seen,
  );
  const look = environmentLook({
    prometheus: new Prometheus('http://prometheus', fetcher),
    loki: new Loki('http://loki', fetcher),
    tempo: new Tempo('http://tempo', fetcher),
  });
  if (!look) throw new Error('no look');
  return { look, seen };
}

const byName = async (look: Promise<{ dependencies: { name: string }[] }>) =>
  Object.fromEntries((await look).dependencies.map(({ name, ...reading }) => [name, reading]));

describe('the look at what the senses read', () => {
  it('finds each healthy, as of the time asked, saying what it saw', async () => {
    const { look, seen } = backends({});
    expect(await byName(look(at))).toEqual({
      prometheus: { healthy: true, saw: 'all 1 targets up, and metrics arriving over OTLP from 10 services' },
      disk: { healthy: true, saw: 'the fullest volume (telemetry/storage-loki-0) 94% free' },
      loki: { healthy: true, saw: '1530 records stored in the 5 minutes before' },
      tempo: { healthy: true, saw: 'traces stored in the 10 minutes before' },
    });
    expect(seen.find((url) => url.pathname === '/api/v1/query')?.searchParams.get('time')).toBe(
      String(at.getTime() / 1000),
    );
    // What the collector in `telemetry` stored, and not the pod log collector's, which arrive by another way.
    expect(seen.find((url) => url.pathname === '/loki/api/v1/query')?.searchParams.get('query')).toContain(
      'service_name!="pod-logs"',
    );
    const search = seen.find((url) => url.pathname === '/api/search');
    expect(search?.searchParams.get('end')).toBe(String(at.getTime() / 1000));
  });

  it('finds Loki unhealthy when it answers with nothing, as on 13 October, and Tempo when it has no trace', async () => {
    const { look } = backends({ records: vector(), traces: [] });
    const readings = await byName(look(at));
    expect(readings.loki).toEqual({ healthy: false, saw: 'no record stored from anything in the 5 minutes before' });
    expect(readings.tempo).toEqual({ healthy: false, saw: 'no trace stored from anything in the 10 minutes before' });
  });

  it('cannot tell about Tempo when it answers a search with something else', async () => {
    const { look } = backends({ traces: null as unknown as unknown[] });
    expect((await byName(look(at))).tempo).toEqual({
      healthy: null,
      saw: 'could not ask: Tempo answered a search with something else',
    });
  });

  it('finds Prometheus unhealthy with a target down, no scrape at all, or no metrics over OTLP', async () => {
    const down = vector([{ job: 'prometheus' }, 1], [{ job: 'kubernetes-pods' }, 0]);
    expect((await byName(backends({ up: down }).look(at))).prometheus).toEqual({
      healthy: false,
      saw: '1 of 2 targets down: kubernetes-pods',
    });
    expect((await byName(backends({ up: vector() }).look(at))).prometheus).toMatchObject({ healthy: false });
    expect((await byName(backends({ otlp: vector() }).look(at))).prometheus).toEqual({
      healthy: false,
      saw: 'all 1 targets up, but no metrics arriving over OTLP',
    });
  });

  it('finds the disk unhealthy below a tenth free, and cannot tell with no measure', async () => {
    const full = vector([{ namespace: 'factory', persistentvolumeclaim: 'data-postgres-0' }, 0.03]);
    expect((await byName(backends({ free: full }).look(at))).disk).toEqual({
      healthy: false,
      saw: 'the fullest volume (factory/data-postgres-0) 3% free',
    });
    expect((await byName(backends({ free: vector() }).look(at))).disk).toEqual({
      healthy: null,
      saw: 'no measure of the cluster’s volumes',
    });
  });

  it('cannot tell about a backend that fails to answer twice, and asks again for the next signal', async () => {
    const seen: URL[] = [];
    const failing = (async (input: URL) => {
      seen.push(input);
      return new Response('', { status: 503 });
    }) as typeof fetch;
    const look = environmentLook({ loki: new Loki('http://loki:3100', failing) });
    expect(await look?.(at)).toEqual({
      at: at.toISOString(),
      dependencies: [{ name: 'loki', healthy: null, saw: 'could not ask: loki:3100/loki/api/v1/query answered 503' }],
    });
    expect(seen).toHaveLength(2);
    await look?.(new Date(at.getTime() + 1000));
    expect(seen).toHaveLength(4);
  });

  it('takes a dropped request again, and asks once a minute when every backend answers', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      return calls === 1 ? new Response('', { status: 502 }) : Response.json(vector([{}, 12]));
    }) as typeof fetch;
    const look = environmentLook({ loki: new Loki('http://loki:3100', flaky) });
    expect((await look?.(at))?.dependencies[0]).toMatchObject({ healthy: true });
    await look?.(new Date(at.getTime() + 1000));
    expect(calls).toBe(2);
    await look?.(new Date(at.getTime() + 60_000));
    expect(calls).toBe(3);
  });

  it('looks at nothing with no backend', () => {
    expect(environmentLook({})).toBeUndefined();
  });
});

describe('Prometheus keeps what the look reads', () => {
  interface ScrapeConfig {
    enabled?: boolean;
    metric_relabel_configs?: { source_labels?: string[]; regex?: string; action?: string }[];
  }
  const values = async (file: string) => parse(await readFile(join(DEPLOY, file), 'utf-8'));
  // Prometheus anchors a relabelling regex at both ends.
  const drops = (config: ScrapeConfig | undefined, name: string) =>
    (config?.metric_relabel_configs ?? []).some(
      (rule) =>
        rule.action === 'drop' &&
        rule.source_labels?.join(';') === '__name__' &&
        new RegExp(`^(?:${rule.regex})$`).test(name),
    );

  it('still scrapes the kubelet’s volume stats on k3s, with the second copy of its metrics dropped', async () => {
    const local = (await values('overlays/local/values/prometheus.yaml')) as {
      scrapeConfigs: Record<string, ScrapeConfig>;
    };
    expect(local.scrapeConfigs['kubernetes-api-servers']?.enabled).toBe(false);
    const nodes = local.scrapeConfigs['kubernetes-nodes'];
    expect(nodes?.enabled).not.toBe(false);
    const dropped = (name: string) => drops(nodes, name);
    for (const name of volumes.match(/kubelet_volume_stats_\w+/g) ?? []) expect(dropped(name)).toBe(false);
    expect(dropped('apiserver_request_duration_seconds_bucket')).toBe(true);
    expect(dropped('apiserver_request_duration_seconds_count')).toBe(false);
  });

  it.each([
    'kubernetes-pods',
    'kubernetes-pods-slow',
    'kubernetes-service-endpoints',
    'kubernetes-service-endpoints-slow',
  ])('counts only OTLP’s services in target_info: %s drops what it scrapes', async (job) => {
    const base = (await values('base/telemetry/values/prometheus.yaml')) as {
      scrapeConfigs: Record<string, ScrapeConfig>;
    };
    const config = base.scrapeConfigs[job];
    expect(drops(config, 'target_info')).toBe(true);
    expect(drops(config, 'otelcol_receiver_accepted_metric_points_total')).toBe(false);
  });

  it('is given those values on the local cluster', async () => {
    const kustomization = await readFile(join(DEPLOY, 'overlays/local/kustomization.yaml'), 'utf-8');
    const { patches } = parse(kustomization) as { patches: { target: { name: string }; patch: string }[] };
    const patch = patches.find((p) => p.target.name === 'prometheus')?.patch ?? '';
    expect(parse(patch)).toContainEqual({
      op: 'add',
      path: '/spec/sources/0/helm/valueFiles/-',
      value: '$values/deploy/overlays/local/values/prometheus.yaml',
    });
  });
});
