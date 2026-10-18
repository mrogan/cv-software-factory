import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The platform's own metrics as deploy/ declares them (#385): each component asks Prometheus, through its chart's
 * settings, to scrape it on its metrics port, and the fences around those in Kyverno's and Argo Rollouts' namespaces
 * let Prometheus in on that port and nothing else in. The pod log collector's fence is held with the rest of it, in
 * pod-logs.test.ts.
 */
type Annotations = Record<string, string> | undefined;

/** Each component: its values file, where in it its pods' annotations are, and the port its metrics are served on. */
const COMPONENTS: { name: string; file: string; path: string[]; port: number }[] = [
  { name: 'the collector', file: 'base/telemetry/values/otel-collector.yaml', path: [], port: 8888 },
  { name: 'the pod log collector', file: 'base/pod-logs/values.yaml', path: [], port: 8888 },
  { name: 'Loki', file: 'base/telemetry/values/loki.yaml', path: ['singleBinary'], port: 3100 },
  { name: 'Tempo', file: 'base/telemetry/values/tempo.yaml', path: [], port: 3200 },
  { name: 'Alertmanager', file: 'base/telemetry/values/prometheus.yaml', path: ['alertmanager'], port: 9093 },
  { name: 'Argo Rollouts', file: 'base/rollouts/values.yaml', path: ['controller'], port: 8090 },
  { name: 'Kyverno admission', file: 'base/admission/values/kyverno.yaml', path: ['admissionController'], port: 8000 },
  { name: 'Kyverno reports', file: 'base/admission/values/kyverno.yaml', path: ['reportsController'], port: 8000 },
  { name: 'Argo CD controller', file: 'argocd/values.yaml', path: ['controller'], port: 8082 },
  { name: 'Argo CD server', file: 'argocd/values.yaml', path: ['server'], port: 8083 },
  { name: 'Argo CD repo server', file: 'argocd/values.yaml', path: ['repoServer'], port: 8084 },
  { name: 'Argo CD ApplicationSet', file: 'argocd/values.yaml', path: ['applicationSet'], port: 8080 },
];

async function podAnnotations(file: string, path: string[]): Promise<Annotations> {
  let values = parse(await readFile(join(DEPLOY, file), 'utf-8')) as Record<string, unknown> | undefined;
  for (const key of path) values = values?.[key] as Record<string, unknown> | undefined;
  return values?.podAnnotations as Annotations;
}

describe('the platform’s components', () => {
  it.each(COMPONENTS)('$name asks to be scraped on its metrics port', async ({ file, path, port }) => {
    expect(await podAnnotations(file, path)).toEqual({
      'prometheus.io/scrape': 'true',
      'prometheus.io/port': String(port),
    });
  });
});

interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
  ipBlock?: { cidr: string };
}
interface Policy {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    podSelector?: {
      matchLabels?: Record<string, string>;
      matchExpressions?: { key: string; operator: string; values: string[] }[];
    };
    ingress?: { from?: Peer[]; ports?: { protocol: string; port: number }[] }[];
  };
}

const PROMETHEUS = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'telemetry' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus', 'app.kubernetes.io/component': 'server' } },
};

/** Every ingress rule's peers in a namespace, each with the components its policy selects and the rule's ports. */
async function ingress(namespace: string) {
  return (await deployManifests<Policy>())
    .filter(({ manifest, namespace: ns }) => manifest.kind === 'NetworkPolicy' && ns === namespace)
    .flatMap(({ manifest: { spec } }) => {
      const selector = spec?.podSelector;
      // Which components a policy selects, by their label, or every pod in the namespace.
      const components = selector?.matchExpressions?.find((e) => e.key === 'app.kubernetes.io/component')?.values ?? [
        selector?.matchLabels?.['app.kubernetes.io/component'] ?? 'every pod',
      ];
      return (spec?.ingress ?? []).flatMap((rule) =>
        (rule.from ?? [{}]).map((peer) => ({ components, peer, ports: (rule.ports ?? []).map((p) => p.port) })),
      );
    });
}

describe('the fences around what Prometheus scrapes', () => {
  it('let Prometheus into Argo Rollouts’ controller on 8090 alone, and nothing else in', async () => {
    expect(await ingress('argo-rollouts')).toEqual([
      { components: ['rollouts-controller'], peer: PROMETHEUS, ports: [8090] },
    ]);
  });

  it('let Prometheus into both of Kyverno’s controllers on 8000 alone, beside the API server’s webhook calls', async () => {
    const rules = await ingress('kyverno');
    expect(rules.filter(({ peer }) => !peer.ipBlock)).toEqual([
      { components: ['admission-controller', 'reports-controller'], peer: PROMETHEUS, ports: [8000] },
    ]);
    // The API server, from the node's private addresses, on the webhook's port and no other.
    const apiServer = rules.filter(({ peer }) => peer.ipBlock);
    expect(apiServer.length).toBeGreaterThan(0);
    for (const { components, ports } of apiServer) {
      expect(components).toEqual(['admission-controller']);
      expect(ports).toEqual([9443]);
    }
  });
});
