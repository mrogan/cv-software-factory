import { describe, expect, it } from 'vitest';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { environmentLook } from '../src/environment.ts';
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
      { path: '/api/search', answer: () => ({ traces: answers.traces ?? [{ traceID: 'a' }] }) },
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
    const search = seen.find((url) => url.pathname === '/api/search');
    expect(search?.searchParams.get('end')).toBe(String(at.getTime() / 1000));
  });

  it('finds Loki unhealthy when it answers with nothing, as on 13 October, and Tempo when it has no trace', async () => {
    const { look } = backends({ records: vector(), traces: [] });
    const readings = await byName(look(at));
    expect(readings.loki).toEqual({ healthy: false, saw: 'no record stored from anything in the 5 minutes before' });
    expect(readings.tempo).toEqual({ healthy: false, saw: 'no trace stored from anything in the 10 minutes before' });
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
