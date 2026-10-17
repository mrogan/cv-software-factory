import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The readers of telemetry as deploy/ declares them (#348): the factory's workers reach Prometheus, Loki and Tempo only
 * through the read-only proxy in `telemetry`, which passes queries by GET and refuses the rest, and Prometheus's
 * lifecycle endpoints are off. `make egress` shows the same on the cluster: a reader can query and cannot write.
 */
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  ipBlock?: { cidr: string };
}
interface Rule {
  to?: Peer[];
  ports?: { protocol: string; port: number }[];
}
interface Container {
  name: string;
  env?: { name: string; value?: string }[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: { egress?: Rule[]; template?: { spec?: { containers?: Container[] } } };
}

const READERS = ['triage', 'intake', 'logs', 'line'];
const ADDRESSES = ['PROMETHEUS_URL', 'LOKI_URL', 'TEMPO_URL'];
const PROXY = { matchLabels: { 'app.kubernetes.io/name': 'query' } };
const COLLECTOR = { matchLabels: { 'app.kubernetes.io/name': 'opentelemetry-collector' } };

const manifests = () => deployManifests<Manifest>();

/** The egress rules of the policies in `factory`, each peer on its own: the policy, the peer, the rule's ports. */
async function factoryEgress() {
  return (await manifests())
    .filter(({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'factory')
    .flatMap(({ manifest: policy }) =>
      (policy.spec?.egress ?? []).flatMap((rule) =>
        (rule.to ?? [{}]).map((peer) => ({
          policy: policy.metadata?.name,
          peer,
          ports: (rule.ports ?? []).map((p) => p.port),
        })),
      ),
    );
}

/** The rules that reach into `telemetry`: by its name, the pods named by their labels. */
async function intoTelemetry() {
  return (await factoryEgress())
    .filter(({ peer }) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'telemetry')
    .map(({ policy, peer, ports }) => ({ policy, pods: peer.podSelector, ports }));
}

describe('the factory’s reach into telemetry', () => {
  it('names each namespace it reaches by name, and leaves none open by omission', async () => {
    // A rule with no peer reaches everywhere, and an empty or expression namespace selector reaches every namespace or
    // whichever match: each would take in `telemetry` unnamed. An address block is the line's, to the API server's port, or the local gateway's,
    // to LM Studio on the host.
    const open = (await factoryEgress()).filter(
      ({ peer }) =>
        Object.keys(peer).length === 0 ||
        (peer.namespaceSelector !== undefined && !peer.namespaceSelector.matchLabels?.['kubernetes.io/metadata.name']),
    );
    expect(open).toEqual([]);
    const blocks = (await factoryEgress()).filter(
      ({ peer }) => peer.ipBlock && !peer.ipBlock.cidr.startsWith('0.0.0.0'),
    );
    expect(new Set(blocks.map(({ policy, ports }) => `${policy} ${ports}`))).toEqual(
      new Set(['line 6443', 'gateway-local-models 1234']),
    );
  });

  it('is the collector’s OTLP port and the read-only proxy, and never a backend itself', async () => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const rules = await intoTelemetry();
    expect(rules.filter(({ pods }) => !same(pods, PROXY) && !same(pods, COLLECTOR))).toEqual([]);
    // The collector on its OTLP port alone.
    expect(new Set(rules.filter(({ pods }) => same(pods, COLLECTOR)).map(({ ports }) => ports.join()))).toEqual(
      new Set(['4318']),
    );
  });

  it('reaches the proxy from the readers alone, on the ports of the backends each reads', async () => {
    const proxy = (await intoTelemetry()).filter(({ pods }) => JSON.stringify(pods) === JSON.stringify(PROXY));
    expect(proxy.map(({ policy, ports }) => [policy, ports])).toEqual([
      ['triage', [9090, 3100, 3200]],
      ['intake', [9090, 3100]],
      ['logs', [9090, 3100, 3200]],
      ['line', [9090, 3100, 3200]],
    ]);
  });

  it('gives each reader the proxy’s addresses, and no backend’s', async () => {
    const deployments = (await manifests())
      .filter(({ manifest: m, namespace }) => m.kind === 'Deployment' && namespace === 'factory')
      .map(({ manifest }) => manifest)
      .filter((m) => READERS.includes(m.metadata?.name ?? ''));
    expect(deployments.map((d) => d.metadata?.name).sort()).toEqual([...READERS].sort());
    const port = { PROMETHEUS_URL: 9090, LOKI_URL: 3100, TEMPO_URL: 3200 } as Record<string, number>;
    for (const deployment of deployments) {
      const env = (deployment.spec?.template?.spec?.containers ?? []).flatMap((c) => c.env ?? []);
      const addresses = env.filter((e) => ADDRESSES.includes(e.name));
      expect(addresses.length, deployment.metadata?.name).toBeGreaterThan(0);
      for (const { name, value } of addresses) {
        expect(value, `${deployment.metadata?.name} ${name}`).toBe(`http://query.telemetry:${port[name]}`);
      }
    }
  });
});

describe('the read-only proxy', () => {
  const servers = async () => {
    const conf = await readFile(join(DEPLOY, 'base/telemetry/query/nginx.conf'), 'utf-8');
    // Each server block, by the port it listens on. Blocks nest one level (locations, ifs), so a server ends at the
    // first line that closes a brace at its own indent.
    return [...conf.matchAll(/^ {2}server \{\n([\s\S]*?)^ {2}\}$/gm)].map(([, body = '']) => ({
      port: Number(/listen (\d+);/.exec(body)?.[1]),
      body,
    }));
  };

  it('listens on each backend’s port, and on its own for its health', async () => {
    expect((await servers()).map(({ port }) => port)).toEqual([8080, 9090, 3100, 3200]);
  });

  it('answers any method but GET and HEAD with 405, and any path it does not name with 403', async () => {
    for (const { port, body } of (await servers()).filter(({ port }) => port !== 8080)) {
      expect(body, String(port)).toContain('if ($request_method !~ ^(GET|HEAD)$) {\n      return 405;');
      expect(body, String(port)).toContain('location / {\n      return 403;');
    }
  });

  it('passes each path the factory’s clients ask a backend for, on that backend’s port', async () => {
    const byPort = new Map((await servers()).map(({ port, body }) => [port, body]));
    const clients = { prometheus: 9090, loki: 3100, tempo: 3200 };
    for (const [client, port] of Object.entries(clients)) {
      const source = await readFile(new URL(`../src/clients/${client}.ts`, import.meta.url), 'utf-8');
      // The paths the client names whole; a trace's path, built from its id, has a test of its own above.
      const paths = [...source.matchAll(/getJson\([^)]*?'(\/[^']+)'/g)].map(([, path]) => path);
      expect(paths.length, client).toBeGreaterThan(0);
      for (const path of paths) expect(byPort.get(port), `${client} ${path}`).toContain(`location = ${path} {`);
    }
  });

  it('passes on the path nginx has normalised, or the trace id it captured, never the one the client wrote', async () => {
    const conf = await readFile(join(DEPLOY, 'base/telemetry/query/nginx.conf'), 'utf-8');
    const passes = [...conf.matchAll(/proxy_pass ([^;]+);/g)].map(([, target]) => target);
    expect(passes.length).toBeGreaterThan(0);
    for (const target of passes) {
      expect(target).toMatch(/^http:\/\/((prometheus|loki|tempo)\$uri|tempo\/api\/traces\/\$1)(\$is_args\$args)?$/);
    }
  });
});

describe('Prometheus', () => {
  it('has its lifecycle endpoints off, and reloads itself', async () => {
    const values = await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8');
    const parsed = parse(values) as {
      configmapReload: { prometheus: { enabled: boolean } };
      server: { extraFlags: string[] };
    };
    expect(parsed.server.extraFlags).not.toContain('web.enable-lifecycle');
    expect(parsed.server.extraFlags).toContain('config.auto-reload');
    expect(parsed.configmapReload.prometheus.enabled).toBe(false);
  });

  it('keeps seven days, or less before its blocks outgrow the volume', async () => {
    const values = await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8');
    const { server } = parse(values) as {
      server: {
        retention?: string;
        persistentVolume: { size: string };
        tsdb: { retention: { time: string; size: string } };
      };
    };
    // Both binary: Prometheus's 3GB is 3GiB.
    const bytes = (size: string, units: Record<string, number>) => {
      const [, n, unit] = size.match(/^(\d+(?:\.\d+)?)(\w+)$/) ?? [];
      return Number(n) * (units[unit ?? ''] ?? Number.NaN);
    };
    const volume = bytes(server.persistentVolume.size, { Mi: 2 ** 20, Gi: 2 ** 30 });
    const retained = bytes(server.tsdb.retention.size, { MB: 2 ** 20, GB: 2 ** 30 });
    // Size is checked only after compaction, which writes a block before deleting the ones it replaces.
    expect(retained).toBeLessThanOrEqual(volume * 0.75);
    expect(server.tsdb.retention.time).toBe('7d');
    // The chart's flag would be a second, deprecated retention.
    expect(server.retention).toBe('');
  });
});
