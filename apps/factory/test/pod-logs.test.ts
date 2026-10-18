import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { objectives } from '../../../policy/objectives.ts';
import { DEPLOY, manifests } from './deploy.ts';

/**
 * The pod log collector as deploy/ declares it (#385): one on each node, in `pod-logs`, reading every container's log
 * from the node's files and sending it to Loki. It holds a host path and runs as root, so what it may read, what it
 * names its records, and where it may reach are held here.
 */
interface Values {
  mode: string;
  ports: Record<string, { enabled: boolean }>;
  serviceAccount: { automountServiceAccountToken: boolean };
  alternateConfig: {
    receivers: Record<string, { include: string[]; exclude: string[]; storage?: string }>;
    processors: Record<string, { attributes?: { key: string; value: string; action: string }[] }>;
    exporters: Record<string, { endpoint: string }>;
    extensions: Record<string, { directory?: string }>;
    service: { pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }> };
  };
  extraVolumes: { name: string; hostPath?: { path: string } }[];
  extraVolumeMounts: { name: string; mountPath: string; readOnly?: boolean }[];
  podSecurityContext: Record<string, unknown>;
  securityContext: { allowPrivilegeEscalation: boolean; readOnlyRootFilesystem: boolean; capabilities: unknown };
}
interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: {
    destination?: { namespace: string };
    sources?: { chart?: string; targetRevision?: string }[];
    podSelector?: { matchLabels?: Record<string, string> };
    policyTypes?: string[];
    ingress?: unknown[];
    egress?: { to?: Peer[]; ports?: { protocol: string; port: number }[] }[];
  };
}

const values = async () => parse(await readFile(join(DEPLOY, 'base/pod-logs/values.yaml'), 'utf-8')) as Values;

/** Whether a filelog glob matches a path: `*` within one path segment, as Go's filepath.Match. */
const matches = (glob: string, path: string) =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`).test(path);

/** Whether the collector reads a container's log, by the path the kubelet writes it to. */
async function reads(namespace: string, pod: string, container: string) {
  const { alternateConfig } = await values();
  const [receiver] = Object.values(alternateConfig.receivers);
  const path = `/var/log/pods/${namespace}_${pod}_0f8e2b9c-1d3a-4e5f-9a7b-6c5d4e3f2a1b/${container}/0.log`;
  return (
    (receiver?.include ?? []).some((glob) => matches(glob, path)) &&
    !(receiver?.exclude ?? []).some((glob) => matches(glob, path))
  );
}

describe('the pod log collector', () => {
  it('reads every pod’s log, the runners’ and the platform’s, but the scoreboard’s and its own', async () => {
    const { mode, alternateConfig } = await values();
    expect(mode).toBe('daemonset');
    expect(Object.keys(alternateConfig.receivers)).toEqual(['file_log']);
    expect(await reads('argocd', 'argocd-server-7d9f8b6c5-x2x4q', 'server')).toBe(true);
    expect(await reads('kyverno', 'kyverno-admission-controller-0', 'kyverno')).toBe(true);
    expect(await reads('runners', 'step-42-agent-abcde', 'agent')).toBe(true);
    expect(await reads('factory', 'postgres-0', 'postgres')).toBe(true);
    expect(await reads('telemetry', 'loki-0', 'loki')).toBe(true);
    // The scoreboard sends nothing by design, its log included.
    expect(await reads('scoreboard', 'scoreboard-6b7c8d9e0f-abcde', 'scoreboard')).toBe(false);
    expect(await reads('pod-logs', 'pod-logs-agent-abcde', 'opentelemetry-collector')).toBe(false);
  });

  it('names every record its own service, never the app’s, whose stream the senses read by its pod', async () => {
    const { alternateConfig } = await values();
    // Loki makes k8s.pod.name a stream label, the stamp the senses read beside the app's service name
    // (provenance.ts): under any other name, the app's pods' output is not counted twice.
    const { logs } = alternateConfig.service.pipelines;
    expect(Object.keys(alternateConfig.service.pipelines)).toEqual(['logs']);
    const named = (logs?.processors ?? []).flatMap((p) =>
      (alternateConfig.processors[p]?.attributes ?? []).filter((a) => a.key === 'service.name'),
    );
    expect(named).toEqual([{ key: 'service.name', value: 'pod-logs', action: 'upsert' }]);
    expect(named[0]?.value).not.toBe(objectives.app.logsService);
    expect(logs?.exporters.map((e) => alternateConfig.exporters[e]?.endpoint)).toEqual([
      'http://loki.telemetry:3100/otlp',
    ]);
  });

  it('mounts the node’s pod logs read-only and its own marks, and nothing else of the node', async () => {
    const { extraVolumes, extraVolumeMounts, alternateConfig } = await values();
    expect(extraVolumes.map((v) => v.hostPath?.path)).toEqual(['/var/log/pods', '/var/lib/otelcol/pod-logs']);
    const mount = (path: string) => extraVolumeMounts.find((m) => m.mountPath === path);
    expect(mount('/var/log/pods')?.readOnly).toBe(true);
    expect(alternateConfig.extensions.file_storage?.directory).toBe(mount('/var/lib/otelcol/pod-logs')?.mountPath);
    expect(alternateConfig.receivers.file_log?.storage).toBe('file_storage');
  });

  it('runs as root with every capability dropped, listens on nothing, and has no token', async () => {
    const { ports, serviceAccount, podSecurityContext, securityContext } = await values();
    expect(Object.entries(ports).filter(([, port]) => port.enabled)).toEqual([]);
    expect(serviceAccount.automountServiceAccountToken).toBe(false);
    expect(podSecurityContext).toMatchObject({ runAsUser: 0, seccompProfile: { type: 'RuntimeDefault' } });
    expect(securityContext).toEqual({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ['ALL'] },
    });
  });

  it('is alone in the one namespace that does not enforce the restricted standard', async () => {
    const all = await manifests<Manifest>();
    const loose = all.filter(
      ({ manifest }) =>
        manifest.kind === 'Namespace' &&
        manifest.metadata?.labels?.['pod-security.kubernetes.io/enforce'] !== 'restricted',
    );
    expect(loose.map(({ manifest }) => manifest.metadata?.name)).toEqual(['pod-logs']);
    const into = all.filter(
      ({ manifest }) => manifest.kind === 'Application' && manifest.spec?.destination?.namespace === 'pod-logs',
    );
    expect(into.map(({ manifest }) => manifest.metadata?.name)).toEqual(['pod-logs']);
    // Beside the chart, only its fences.
    const beside = all.filter(({ namespace }) => namespace === 'pod-logs').map(({ manifest }) => manifest.kind);
    expect(new Set(beside)).toEqual(new Set(['NetworkPolicy']));
    // The same chart at the same version as the collector in `telemetry`, so the two move together.
    const chart = (name: string) =>
      all.find(({ manifest }) => manifest.kind === 'Application' && manifest.metadata?.name === name)?.manifest.spec
        ?.sources?.[0];
    expect(chart('pod-logs')).toMatchObject({
      chart: chart('otel-collector')?.chart,
      targetRevision: chart('otel-collector')?.targetRevision,
    });
  });

  it('is fenced: nothing reaches it, and it reaches Loki and DNS alone', async () => {
    const policies = (await manifests<Manifest>())
      .filter(({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'pod-logs')
      .map(({ manifest }) => manifest);
    const deny = policies.find((p) => p.metadata?.name === 'default-deny');
    expect(deny?.spec).toEqual({ podSelector: {}, policyTypes: ['Ingress', 'Egress'] });
    expect(policies.flatMap((p) => p.spec?.ingress ?? [])).toEqual([]);
    const egress = policies.flatMap((p) => p.spec?.egress ?? []);
    const reaches = egress.flatMap((rule) =>
      (rule.to ?? [{}]).map((peer) => ({
        namespace: peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'],
        pods: peer.podSelector?.matchLabels,
        ports: (rule.ports ?? []).map((p) => `${p.protocol}/${p.port}`),
      })),
    );
    expect(reaches).toEqual([
      { namespace: 'kube-system', pods: { 'k8s-app': 'kube-dns' }, ports: ['UDP/53', 'TCP/53'] },
      {
        namespace: 'telemetry',
        pods: { 'app.kubernetes.io/name': 'loki', 'app.kubernetes.io/component': 'single-binary' },
        ports: ['TCP/3100'],
      },
    ]);
  });
});
