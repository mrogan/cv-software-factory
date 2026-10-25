import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * Feature flags' fences as deploy/ declares them (milestone 7): flagd alone in `flagd`, reading the one FeatureFlag,
 * `flags`, and writing nothing; nobody of ours writing `flags` but the services named here; the resource made by Argo
 * CD and its flags left alone; admission keeping it the only one and never deleted; and flagd reached by the app's
 * pods on its sync and health ports alone.
 */
interface Rule {
  apiGroups?: string[];
  resources?: string[];
  resourceNames?: string[];
  verbs?: string[];
}
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
  ipBlock?: { cidr: string };
}
interface NetworkRule {
  from?: Peer[];
  to?: Peer[];
  ports?: { protocol: string; port: number }[];
}
interface Container {
  image: string;
  args?: string[];
  ports?: { name: string; containerPort: number }[];
  readinessProbe?: { httpGet?: { path: string; port: string } };
}
type Kinds = { group: string; kind: string }[];
/** The parts of each kind's spec these tests read. */
interface Spec {
  // A Deployment's
  template?: {
    spec: {
      serviceAccountName?: string;
      automountServiceAccountToken?: boolean;
      initContainers?: Container[];
      containers: Container[];
    };
  };
  // An AppProject's
  destinations?: { namespace: string }[];
  namespaceResourceWhitelist?: Kinds;
  clusterResourceWhitelist?: Kinds;
  // A CustomResourceDefinition's, and the FeatureFlag's
  group?: string;
  flagSpec?: unknown;
  // An Application's
  ignoreDifferences?: unknown[];
  syncPolicy?: { syncOptions?: string[] };
  // An admission policy's, and its binding's
  failurePolicy?: string;
  matchConstraints?: unknown;
  matchConditions?: unknown[];
  validations?: { expression: string }[];
  policyName?: string;
  validationActions?: string[];
  // A NetworkPolicy's
  podSelector?: unknown;
  policyTypes?: string[];
  ingress?: NetworkRule[];
  egress?: NetworkRule[];
  // A Service's
  ports?: { port: number; targetPort: string }[];
}
interface Manifest {
  kind?: string;
  apiVersion?: string;
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  rules?: Rule[];
  roleRef?: { kind: string; name: string };
  subjects?: { kind: string; name: string; namespace?: string }[];
  spec?: Spec;
}

const manifests = () => deployManifests<Manifest>();

const GROUP = 'core.openfeature.dev';
const READ = ['get', 'list', 'watch'];
const WAVE = 'argocd.argoproj.io/sync-wave';
const wave = (manifest?: Manifest) => Number(manifest?.metadata?.annotations?.[WAVE] ?? 0);

/**
 * The service accounts of ours that may write `flags`, each with its reason. None today: task 16 gives the admin
 * service its Role on `flags`, by name, for Martin's stages, and adds it here, `factory/admin`. Any other is a failure.
 */
const WRITERS: Record<string, string> = {};

/**
 * The cluster's own controllers, which may write any resource, and are trusted to: none of their rights is in deploy/.
 * Argo CD's application controller, installed by `make up`, makes `flags` from Git and leaves its flags alone
 * (root's ignoreDifferences). Kyverno's controllers, from its chart, write only what a policy has them mutate or
 * generate, and deploy/ has no such policy. Kubernetes's own, in `kube-system`, delete it only with its namespace.
 */
const TRUSTED = ['Argo CD’s application controller', 'Kyverno’s controllers', 'Kubernetes’s own controllers'];

/** Whether a rule of a Role or ClusterRole lets its holder do anything to FeatureFlags but read them. */
const writes = (rule: Rule) =>
  (rule.apiGroups ?? []).some((g) => g === GROUP || g === '*') &&
  (rule.resources ?? []).some((r) => r === '*' || r === 'featureflags' || r.startsWith('featureflags/')) &&
  (rule.verbs ?? []).some((v) => !READ.includes(v));

describe('flagd’s rights', () => {
  it('read featureflags in flagd, with no names, and write nothing', async () => {
    const all = await manifests();
    const roles = all.filter(
      ({ manifest }) => manifest.kind === 'Role' && manifest.metadata?.name === 'flagd-reads-flags',
    );
    expect(roles.map(({ file, namespace }) => [file, namespace])).toEqual([['base/flagd/flagd.yaml', 'flagd']]);
    // Its watch lists the whole namespace, so no names; admission keeps `flags` the only one there.
    expect(roles[0]?.manifest.rules).toEqual([{ apiGroups: [GROUP], resources: ['featureflags'], verbs: READ }]);
  });

  it('are bound to flagd’s own service account alone, and its account holds no other', async () => {
    const all = await manifests();
    const bound = all.filter(({ manifest }) => manifest.roleRef?.name === 'flagd-reads-flags');
    expect(
      bound.map(({ manifest, namespace }) => [manifest.kind, namespace, manifest.roleRef, manifest.subjects]),
    ).toEqual([
      [
        'RoleBinding',
        'flagd',
        { apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: 'flagd-reads-flags' },
        [{ kind: 'ServiceAccount', name: 'flagd', namespace: 'flagd' }],
      ],
    ]);
    const flagds = all.filter(({ manifest }) =>
      manifest.subjects?.some((s) => s.namespace === 'flagd' || (s.kind === 'Group' && s.name.includes('flagd'))),
    );
    expect(flagds.map(({ manifest }) => manifest.roleRef?.name)).toEqual(['flagd-reads-flags']);
  });

  it('are held by flagd’s pod alone, the only one in its namespace, watching flags', async () => {
    const workloads = (await manifests()).filter(
      ({ manifest, namespace }) =>
        namespace === 'flagd' &&
        ['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'Pod', 'ReplicaSet'].includes(manifest.kind ?? ''),
    );
    expect(workloads.map(({ manifest }) => `${manifest.kind}/${manifest.metadata?.name}`)).toEqual([
      'Deployment/flagd',
    ]);
    const pod = workloads[0]?.manifest.spec?.template?.spec;
    expect(pod?.serviceAccountName).toBe('flagd');
    expect(pod?.automountServiceAccountToken).toBe(true);
    expect(pod?.initContainers).toBeUndefined();
    const [container, ...others] = pod?.containers ?? [];
    expect(others).toEqual([]);
    expect(container?.image).toMatch(/^ghcr\.io\/open-feature\/flagd:v[\d.]+@sha256:[0-9a-f]{64}$/);
    expect(container?.args).toEqual(['start', '--uri=core.openfeature.dev/flagd/flags', '--log-format=json']);
    // Ready only once it has read flags and started its watch.
    expect(container?.readinessProbe?.httpGet).toEqual({ path: '/readyz', port: 'management' });
  });
});

describe('who may write flags', () => {
  it('is no service of ours but the ones named, by any Role or ClusterRole deploy/ makes', async () => {
    const all = await manifests();
    const writing = all
      .filter(({ manifest }) => ['Role', 'ClusterRole'].includes(manifest.kind ?? ''))
      .filter(({ manifest }) => (manifest.rules ?? []).some(writes));
    const holders = writing.flatMap(({ manifest, namespace }) =>
      all
        .filter(
          ({ manifest: binding, namespace: bound }) =>
            binding.kind?.endsWith('RoleBinding') &&
            binding.roleRef?.kind === manifest.kind &&
            binding.roleRef?.name === manifest.metadata?.name &&
            (manifest.kind === 'ClusterRole' || bound === namespace),
        )
        .flatMap(({ manifest: binding }) =>
          (binding.subjects ?? []).map((s) => (s.kind === 'ServiceAccount' ? `${s.namespace}/${s.name}` : s.name)),
        ),
    );
    expect(holders.sort()).toEqual(Object.keys(WRITERS).sort());
    // A role that may write them and is bound to nobody is a right waiting for a binding.
    expect(writing.length).toBe(Object.keys(WRITERS).length);
  });

  it('is no chart’s: none deploys into flagd, and the app’s repository may make no FeatureFlag', async () => {
    const projects = (await manifests()).filter(({ manifest }) => manifest.kind === 'AppProject');
    expect(projects.length).toBeGreaterThan(0);
    for (const { manifest } of projects) {
      const destinations = (manifest.spec?.destinations ?? []).map((d) => d.namespace);
      expect(destinations, manifest.metadata?.name).not.toContain('flagd');
      expect(destinations, manifest.metadata?.name).not.toContain('*');
      const kinds = [
        ...(manifest.spec?.namespaceResourceWhitelist ?? []),
        ...(manifest.spec?.clusterResourceWhitelist ?? []),
      ];
      expect(
        kinds.filter((k) => k.group === GROUP || k.group === '*'),
        manifest.metadata?.name,
      ).toEqual([]);
    }
  });

  it('is, beyond those, the cluster’s own controllers alone, which no policy here has write it', async () => {
    expect(TRUSTED).toHaveLength(3);
    // Kyverno writes only what a policy has it mutate or generate: deploy/ has no such policy, nor Kubernetes's own
    // mutating kind.
    const mutating = (await manifests()).filter(({ manifest }) =>
      ['MutatingPolicy', 'GeneratingPolicy', 'ClusterPolicy', 'Policy', 'MutatingAdmissionPolicy'].includes(
        manifest.kind ?? '',
      ),
    );
    expect(mutating.map(({ file }) => file)).toEqual([]);
    // And no binding of ours is cluster-wide, which would reach flagd's namespace from outside it.
    const clusterWide = (await manifests()).filter(({ manifest }) =>
      ['ClusterRole', 'ClusterRoleBinding'].includes(manifest.kind ?? ''),
    );
    expect(clusterWide).toEqual([]);
  });
});

describe('flags', () => {
  it('is the only FeatureFlag deploy/ makes, in flagd, with no flags', async () => {
    const flags = (await manifests()).filter(({ manifest }) => manifest.kind === 'FeatureFlag');
    expect(flags.map(({ manifest, namespace }) => [manifest.apiVersion, namespace, manifest.metadata?.name])).toEqual([
      [`${GROUP}/v1beta1`, 'flagd', 'flags'],
    ]);
    expect(flags[0]?.manifest.spec).toEqual({ flagSpec: { flags: {} } });
    // Never pruned, nor deleted with root: admission refuses its deletion, so either would only fail the sync.
    expect(flags[0]?.manifest.metadata?.annotations?.['argocd.argoproj.io/sync-options']?.split(',')).toEqual(
      expect.arrayContaining(['Prune=false', 'Delete=false']),
    );
  });

  it('is made after its kind’s definition and before flagd, which does not start without it', async () => {
    const all = await manifests();
    const find = (kind: string, name: string) =>
      all.find(({ manifest }) => manifest.kind === kind && manifest.metadata?.name === name)?.manifest;
    const definition = find('CustomResourceDefinition', `featureflags.${GROUP}`);
    const flags = find('FeatureFlag', 'flags');
    expect(definition?.spec?.group).toBe(GROUP);
    expect(wave(definition)).toBeLessThan(wave(flags));
    for (const kind of ['ServiceAccount', 'Role', 'RoleBinding', 'Deployment']) {
      const name = kind.startsWith('Role') ? 'flagd-reads-flags' : 'flagd';
      expect(wave(flags), kind).toBeLessThan(wave(find(kind, name)));
    }
    // On a new cluster the kind is not defined when Argo CD first dry-runs the sync.
    expect(flags?.metadata?.annotations?.['argocd.argoproj.io/sync-options']).toContain(
      'SkipDryRunOnMissingResource=true',
    );
  });

  it('has its flags left to Martin by root: never reported as drift, never put back', async () => {
    const root = parse(await readFile(join(DEPLOY, 'argocd/root.yaml'), 'utf-8')) as Manifest;
    expect(root.spec?.ignoreDifferences).toEqual([
      { group: GROUP, kind: 'FeatureFlag', namespace: 'flagd', name: 'flags', jsonPointers: ['/spec/flagSpec/flags'] },
    ]);
    expect(root.spec?.syncPolicy?.syncOptions).toContain('RespectIgnoreDifferences=true');
  });

  it('is kept the only one in flagd, and never deleted, by a policy that holds everyone', async () => {
    const all = await manifests();
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'ValidatingAdmissionPolicy' && manifest.metadata?.name === 'flags',
    );
    expect(policy?.file).toBe('base/admission/flagd/flags.yaml');
    const spec = policy?.manifest.spec;
    expect(spec?.failurePolicy).toBe('Fail');
    expect(spec?.matchConstraints).toEqual({
      namespaceSelector: {
        matchExpressions: [{ key: 'kubernetes.io/metadata.name', operator: 'In', values: ['flagd'] }],
      },
      resourceRules: [
        { apiGroups: [GROUP], apiVersions: ['*'], operations: ['CREATE', 'DELETE'], resources: ['featureflags'] },
      ],
    });
    // Every request, Argo CD's and an administrator's too.
    expect(spec?.matchConditions).toBeUndefined();
    expect(spec?.validations?.map((v) => v.expression)).toEqual([
      "request.operation != 'CREATE' || object.metadata.name == 'flags'",
      "request.operation != 'DELETE' || has(namespaceObject.metadata.deletionTimestamp)",
    ]);
    const rendered = parseAllDocuments(
      execFileSync('kustomize', ['build', join(DEPLOY, 'base/admission/flagd')], { encoding: 'utf-8' }),
    ).map((doc) => doc.toJS() as Manifest);
    const binding = rendered.find((r) => r.kind === 'ValidatingAdmissionPolicyBinding');
    expect(rendered.find((r) => r.kind === 'ValidatingAdmissionPolicy')?.metadata?.name).toBe('flagd-flags');
    expect(binding?.spec).toEqual({ policyName: 'flagd-flags', validationActions: ['Deny'] });
  });

  it('was answered by the cluster as the policy says (scripts/flags-refusals.sh)', async () => {
    const kept = JSON.parse(await readFile(join(DEPLOY, 'test', 'flags-refusals.json'), 'utf-8')) as {
      case: string;
      outcome: string;
      message: string;
    }[];
    expect(Object.fromEntries(kept.map((k) => [k.case, k.outcome]))).toEqual({
      second: 'refused',
      delete: 'refused',
      change: 'admitted',
    });
    for (const refusal of kept.filter((k) => k.outcome === 'refused')) {
      expect(refusal.message, refusal.case).toContain("ValidatingAdmissionPolicy 'flagd-flags'");
    }
  });
});

describe('flagd’s fence', () => {
  const describePeer = (peer: Peer) =>
    peer.ipBlock
      ? peer.ipBlock.cidr
      : [peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'], peer.podSelector?.matchLabels];
  const describeRules = (rules: NetworkRule[] = [], side: 'from' | 'to') =>
    rules.map((rule) => ({
      [side]: (rule[side] ?? []).map(describePeer),
      ports: (rule.ports ?? []).map((p) => `${p.protocol}/${p.port}`),
    }));
  const policies = async () =>
    (await manifests()).filter(({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'flagd');

  it('denies everything in flagd, and then lets in the app’s pods on the sync and health ports alone', async () => {
    const all = await policies();
    expect(all.map(({ manifest }) => manifest.metadata?.name)).toEqual(['default-deny', 'flagd']);
    const deny = all[0]?.manifest.spec;
    expect(deny).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    const flagd = all[1]?.manifest.spec;
    expect(flagd?.podSelector).toEqual({ matchLabels: { 'app.kubernetes.io/name': 'flagd' } });
    expect(describeRules(flagd?.ingress, 'from')).toEqual([
      { from: [['website', { 'app.kubernetes.io/name': 'website' }]], ports: ['TCP/8015', 'TCP/8014'] },
    ]);
  });

  it('lets flagd reach DNS, the API server’s port and the collector’s OTLP port, and nothing else', async () => {
    const flagd = (await policies())[1]?.manifest.spec;
    expect(describeRules(flagd?.egress, 'to')).toEqual([
      { to: [['kube-system', { 'k8s-app': 'kube-dns' }]], ports: ['UDP/53', 'TCP/53'] },
      { to: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'], ports: ['TCP/6443'] },
      { to: [['telemetry', { 'app.kubernetes.io/name': 'opentelemetry-collector' }]], ports: ['TCP/4318'] },
    ]);
  });

  it('serves those two ports on its Service, to the ports flagd listens on for them', async () => {
    const all = await manifests();
    const service = all.find(({ manifest, namespace }) => manifest.kind === 'Service' && namespace === 'flagd')
      ?.manifest.spec;
    expect(service?.ports?.map((p) => [p.port, p.targetPort])).toEqual([
      [8015, 'sync'],
      [8014, 'management'],
    ]);
    const container = all.find(({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'flagd')
      ?.manifest.spec?.template?.spec.containers[0];
    expect(container?.ports).toEqual([
      { name: 'sync', containerPort: 8015 },
      { name: 'management', containerPort: 8014 },
    ]);
  });
});
