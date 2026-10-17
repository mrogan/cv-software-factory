import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The release's fences as deploy/ declares them: who may change a Rollout, what the line may read of a release, what
 * the analysis Job may reach, and what the app's own pods may reach and be reached by.
 */
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  rules?: { apiGroups?: string[]; resources?: string[]; verbs?: string[] }[];
  roleRef?: { kind: string; name: string };
  subjects?: { kind: string; name: string; namespace?: string }[];
  spec?: Record<string, unknown>;
}

const manifests = () => deployManifests<Manifest>();

const READ = ['get', 'list', 'watch'];

describe('stopping a release is Martin’s (make stop-the-line)', () => {
  it('gives no service account the right to change a Rollout: a role may at most read one', async () => {
    const roles = (await manifests()).filter(({ manifest }) => ['Role', 'ClusterRole'].includes(manifest.kind ?? ''));
    const changes = roles.flatMap(({ file, manifest }) =>
      (manifest.rules ?? [])
        .filter(
          (rule) =>
            rule.apiGroups?.some((g) => g === 'argoproj.io' || g === '*') &&
            rule.resources?.some((r) => r === '*' || r.startsWith('rollouts')) &&
            rule.verbs?.some((v) => !READ.includes(v)),
        )
        .map(() => `${file}: ${manifest.metadata?.name}`),
    );
    expect(changes).toEqual([]);
  });

  it('binds nobody to the built-in roles that could change one, and adds Rollouts to none of them', async () => {
    const bindings = (await manifests()).filter(({ manifest }) => manifest.kind?.endsWith('RoleBinding'));
    const builtIn = bindings.filter(({ manifest }) =>
      ['cluster-admin', 'admin', 'edit'].includes(manifest.roleRef?.name ?? ''),
    );
    expect(builtIn).toEqual([]);
    // The chart would otherwise aggregate the right to change Rollouts into `admin` and `edit`.
    const values = parse(await readFile(join(DEPLOY, 'base/rollouts/values.yaml'), 'utf-8'));
    expect(values.createClusterAggregateRoles).toBe(false);
  });
});

describe('the line’s watch of a release', () => {
  it('may read the app’s Rollout, its AnalysisRuns and the journeys’ pods, and nothing else in the app’s namespace', async () => {
    const all = await manifests();
    const line = all.filter(({ manifest }) =>
      manifest.subjects?.some((s) => s.kind === 'ServiceAccount' && s.name === 'line' && s.namespace === 'factory'),
    );
    // Nothing cluster-wide: each right is a Role's, in one namespace.
    expect(line.filter(({ manifest }) => manifest.kind !== 'RoleBinding')).toEqual([]);
    const inWebsite = line.filter(({ manifest }) => manifest.metadata?.namespace === 'website');
    expect(inWebsite.map(({ manifest }) => manifest.roleRef)).toEqual([
      { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'line-reads-release' },
    ]);
    const role = all.find(
      ({ manifest }) =>
        manifest.kind === 'Role' &&
        manifest.metadata?.namespace === 'website' &&
        manifest.metadata?.name === 'line-reads-release',
    );
    // Pods to list, for a journeys Job's termination message: not their logs, nor any Job, Secret or other kind.
    expect(role?.manifest.rules).toEqual([
      { apiGroups: ['argoproj.io'], resources: ['rollouts', 'analysisruns'], verbs: READ },
      { apiGroups: [''], resources: ['pods'], verbs: ['list'] },
    ]);
  });
});

describe('the line’s Verify', () => {
  type Peer = { namespaceSelector?: { matchLabels: Record<string, string> }; podSelector?: Record<string, unknown> };
  type Rule = { to?: Peer[]; from?: Peer[]; ports: { protocol: string; port: number }[] };
  type Policy = Manifest & { spec: { ingress?: Rule[]; egress?: Rule[] } };
  const policy = async (name: string) =>
    (await manifests()).find(
      ({ manifest }) =>
        manifest.kind === 'NetworkPolicy' &&
        manifest.metadata?.name === name &&
        (manifest.metadata?.namespace ?? 'factory') === 'factory',
    )?.manifest as Policy;
  const peers = (rules: Rule[] = [], side: 'to' | 'from') =>
    rules.map((rule) => ({
      peers: (rule[side] ?? []).map((peer) => [
        peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'] ?? 'factory',
        peer.podSelector,
      ]),
      ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
    }));

  it('reaches the probes’ verification, and Prometheus, Loki and Tempo through the read-only proxy alone', async () => {
    const egress = peers((await policy('line')).spec.egress, 'to');
    expect(egress).toContainEqual({
      peers: [['factory', { matchLabels: { 'app.kubernetes.io/name': 'probes' } }]],
      ports: ['TCP/8081'],
    });
    // Every rule of the line's that leaves its own namespace, by any namespace selector: the proxy's pods, on the ports
    // of the three backends (Tempo's query port, for the log watcher's agreement check), and never a backend itself
    // (telemetry-fences.test.ts).
    const raw = (await policy('line')).spec.egress ?? [];
    const elsewhere = raw.filter((rule) => rule.to?.some((peer) => peer.namespaceSelector !== undefined));
    expect(peers(elsewhere, 'to')).toEqual([
      {
        peers: [['telemetry', { matchLabels: { 'app.kubernetes.io/name': 'query' } }]],
        ports: ['TCP/9090', 'TCP/3100', 'TCP/3200'],
      },
    ]);
  });

  it('is let in by the probes on the verification’s port alone, and the page reader’s is triage’s', async () => {
    expect(peers((await policy('probes')).spec.ingress, 'from')).toEqual([
      { peers: [['factory', { matchLabels: { 'app.kubernetes.io/name': 'triage' } }]], ports: ['TCP/8080'] },
      { peers: [['factory', { matchLabels: { 'app.kubernetes.io/name': 'line' } }]], ports: ['TCP/8081'] },
    ]);
  });
});

describe("the analysis Job's fence", () => {
  it('selects the pods the journeys Job makes, in the namespace it runs in', async () => {
    const all = await manifests();
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'NetworkPolicy' && manifest.metadata?.name === 'journeys',
    )?.manifest as Manifest & { spec: { podSelector: { matchLabels: Record<string, string> } } };
    expect(policy.metadata?.namespace).toBe('website');
    const templates = all.filter(({ manifest }) => manifest.kind === 'ClusterAnalysisTemplate');
    type Metric = { provider: { job?: { spec: { template: { metadata: { labels: object } } } } } };
    const jobs = templates.flatMap(({ manifest }) =>
      ((manifest.spec?.metrics ?? []) as Metric[]).map((m) => m.provider.job).filter((job) => job !== undefined),
    );
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs)
      expect(job.spec.template.metadata.labels).toMatchObject(policy.spec.podSelector.matchLabels);
  });
});

describe("the app's fence", () => {
  type Peer = {
    namespaceSelector?: { matchLabels: Record<string, string> };
    podSelector?: {
      matchLabels?: Record<string, string>;
      matchExpressions?: { key: string; operator: string; values: string[] }[];
    };
  };
  type Rule = { to?: Peer[]; from?: Peer[]; ports: { protocol: string; port: number }[] };
  type Policy = Manifest & {
    spec: { podSelector: { matchLabels: Record<string, string> }; ingress: Rule[]; egress: Rule[] };
  };
  const fence = async () =>
    (await manifests()).find(
      ({ manifest }) =>
        manifest.kind === 'NetworkPolicy' &&
        manifest.metadata?.namespace === 'website' &&
        manifest.metadata?.name === 'website',
    )?.manifest as Policy;

  /** Whether a peer selects pods in a namespace with these labels. */
  const admits = (peer: Peer, namespace: string, labels: Record<string, string>) =>
    (peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'] ?? 'website') === namespace &&
    Object.entries(peer.podSelector?.matchLabels ?? {}).every(([k, v]) => labels[k] === v) &&
    (peer.podSelector?.matchExpressions ?? []).every(
      (e) => e.operator === 'In' && e.values.includes(labels[e.key] ?? ''),
    );

  it("selects the app's pods, and lets them reach DNS and the collector's OTLP port, nothing else", async () => {
    const policy = await fence();
    expect(policy.spec.podSelector.matchLabels).toEqual({ 'app.kubernetes.io/name': 'website' });
    expect(policy.spec.policyTypes).toEqual(['Ingress', 'Egress']);
    expect(
      policy.spec.egress.map((rule) => ({
        to: rule.to?.map((peer) => [
          peer.namespaceSelector?.matchLabels['kubernetes.io/metadata.name'],
          peer.podSelector?.matchLabels,
        ]),
        ports: rule.ports.map((p) => `${p.protocol}/${p.port}`),
      })),
    ).toEqual([
      { to: [['kube-system', { 'k8s-app': 'kube-dns' }]], ports: ['UDP/53', 'TCP/53'] },
      { to: [['telemetry', { 'app.kubernetes.io/name': 'opentelemetry-collector' }]], ports: ['TCP/4318'] },
    ]);
  });

  it('lets in, on 8080 only, the pods of the probes, the crawler and the journeys Job, by the labels they carry', async () => {
    const all = await manifests();
    const policy = await fence();
    const podLabels = (name: string) => {
      const found = all.find(({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === name);
      if (!found) throw new Error(`No Deployment ${name} in deploy/`);
      return (found.manifest.spec as { template: { metadata: { labels: Record<string, string> } } }).template.metadata
        .labels;
    };
    type Metric = { provider: { job?: { spec: { template: { metadata: { labels: Record<string, string> } } } } } };
    const journeys = all
      .filter(({ manifest }) => manifest.kind === 'ClusterAnalysisTemplate')
      .flatMap(({ manifest }) => (manifest.spec?.metrics ?? []) as Metric[])
      .flatMap((m) => (m.provider.job ? [m.provider.job.spec.template.metadata.labels] : []));
    expect(journeys.length).toBeGreaterThan(0);
    const callers: [string, Record<string, string>][] = [
      ['factory', podLabels('probes')],
      ['factory', podLabels('crawler')],
      ...journeys.map((labels): [string, Record<string, string>] => ['website', labels]),
      ['kube-system', { 'app.kubernetes.io/name': 'traefik' }],
    ];
    expect(policy.spec.ingress.flatMap((rule) => rule.ports.map((p) => `${p.protocol}/${p.port}`))).toEqual([
      'TCP/8080',
    ]);
    const from = policy.spec.ingress.flatMap((rule) => rule.from ?? []);
    for (const [namespace, labels] of callers) expect(from.some((peer) => admits(peer, namespace, labels))).toBe(true);
    // A worker, or another pod in the app's namespace, is not let in.
    const others: [string, Record<string, string>][] = [
      ['factory', podLabels('triage')],
      ['factory', podLabels('gateway')],
      ['website', { 'app.kubernetes.io/name': 'website' }],
    ];
    for (const [namespace, labels] of others) expect(from.some((peer) => admits(peer, namespace, labels))).toBe(false);
  });
});
