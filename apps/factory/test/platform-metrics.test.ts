import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests as deployManifests, PROMETHEUS, type Relabel, relabel } from './deploy.ts';

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

/**
 * Prometheus looks for what asks to be scraped only in the namespaces the platform runs in (#437), so a pod in the
 * app's namespace, which the line changes, cannot become a target.
 */
interface ScrapeJob {
  enabled?: boolean;
  metric_relabel_configs?: Record<string, unknown>[];
  kubernetes_sd_configs?: { role: string; namespaces?: { names?: string[] } }[];
}

/** An Application, or a workload with a pod template: what a component's namespace and annotations are read from. */
interface Workload {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    destination?: { namespace?: string };
    sources?: { helm?: { valueFiles?: string[] } }[];
    template?: { metadata?: { annotations?: Record<string, string> } };
  };
}

/** Whether anything in a manifest or values file asks to be scraped: a `prometheus.io/scrape: "true"` annotation. */
function asks(tree: unknown): boolean {
  if (!tree || typeof tree !== 'object') return false;
  const node = tree as Record<string, unknown>;
  if (node['prometheus.io/scrape'] === 'true') return true;
  return Object.values(node).some(asks);
}

/** The scrape jobs the Prometheus chart is given, as its values file sets them over the chart's own. */
async function scrapeJobs(): Promise<Record<string, ScrapeJob>> {
  const values = parse(await readFile(join(DEPLOY, 'base/telemetry/values/prometheus.yaml'), 'utf-8')) as {
    scrapeConfigs: Record<string, ScrapeJob>;
  };
  return values.scrapeConfigs;
}

/** The chart's jobs that scrape whatever asks with `prometheus.io/` annotations, by pod or by Service (#437). */
const ASKING = {
  'kubernetes-pods': 'pod',
  'kubernetes-pods-slow': 'pod',
  'kubernetes-service-endpoints': 'endpointslice',
  'kubernetes-service-endpoints-slow': 'endpointslice',
};

/** Where each job looks for what asks, or every namespace when it names none. */
async function asked(): Promise<Record<string, string[] | 'every namespace'>> {
  const jobs = await scrapeJobs();
  return Object.fromEntries(
    Object.entries(ASKING).map(([job, role]) => {
      const discovery = jobs[job]?.kubernetes_sd_configs;
      expect(
        discovery?.map((d) => d.role),
        job,
      ).toEqual([role]);
      return [job, discovery?.[0]?.namespaces?.names ?? 'every namespace'];
    }),
  );
}

describe('what Prometheus scrapes because it asks', () => {
  it('is looked for in the same namespaces by every job that reads the annotations', async () => {
    const namespaces = new Set(Object.values(await asked()).map((names) => JSON.stringify(names)));
    expect(namespaces.size).toBe(1);
  });

  it('is never looked for in the app’s namespace, the runners’ or the scoreboard’s', async () => {
    for (const [job, names] of Object.entries(await asked())) {
      expect(names, job).not.toBe('every namespace');
      for (const namespace of ['website', 'runners', 'scoreboard']) expect(names, job).not.toContain(namespace);
    }
  });

  it('is looked for in every namespace a platform component asks from', async () => {
    const pods = (await asked())['kubernetes-pods'];
    const all = await deployManifests<Workload>();
    // A chart's values that ask anywhere in them, by pod or by Service, ask from the namespace its Application installs
    // it in. Argo CD's chart is installed by `make up`, in `argocd`.
    const charts: { file: string; namespace: string | undefined }[] = [
      { file: 'argocd/values.yaml', namespace: 'argocd' },
    ];
    for (const { manifest } of all.filter(({ manifest }) => manifest.kind === 'Application')) {
      for (const source of manifest.spec?.sources ?? []) {
        for (const values of source.helm?.valueFiles ?? []) {
          const file = values.replace('$values/deploy/', '');
          if (file !== values) charts.push({ file, namespace: manifest.spec?.destination?.namespace });
        }
      }
    }
    const asking: string[] = [];
    for (const { file, namespace } of charts) {
      if (!asks(parse(await readFile(join(DEPLOY, file), 'utf-8')))) continue;
      asking.push(file);
      expect(pods, file).toContain(namespace);
    }
    // Pods and Services deploy/ declares itself, such as the Postgres exporter's, as well as the charts'.
    for (const { file, namespace } of all.filter(({ manifest }) => asks(manifest))) {
      asking.push(file);
      expect(pods, file).toContain(namespace);
    }
    for (const { file } of COMPONENTS) expect(asking).toContain(file);
    expect(asking).toContain('base/postgres-exporter/deployment.yaml');
    // Traefik and CoreDNS, which k3s installs in its own namespace, not deploy/.
    expect(pods).toContain('kube-system');
  });

  it('is looked for nowhere else in the local overlay, which sets no discovery of its own', async () => {
    const local = parse(await readFile(join(DEPLOY, 'overlays/local/values/prometheus.yaml'), 'utf-8')) as {
      scrapeConfigs?: Record<string, ScrapeJob>;
    };
    for (const job of Object.keys(ASKING))
      expect(local.scrapeConfigs?.[job]?.kubernetes_sd_configs, job).toBeUndefined();
  });

  it('never keeps the label that marks the app’s own metrics, whichever namespace sent it', async () => {
    const jobs = await scrapeJobs();
    for (const job of Object.keys(ASKING)) {
      expect(jobs[job]?.metric_relabel_configs, job).toContainEqual({
        action: 'labeldrop',
        regex: 'k8s_pod_label_rollouts_pod_template_hash',
      });
    }
  });

  it('never keeps the labels that mark the line’s own counts, which page Martin', async () => {
    const jobs = await scrapeJobs();
    for (const job of Object.keys(ASKING)) {
      const rules = (jobs[job]?.metric_relabel_configs ?? []) as Relabel[];
      const scraped = relabel(rules, {
        __name__: 'line_security_events_total',
        kind: 'sign-in',
        k8s_namespace_name: 'factory',
        k8s_pod_label_app_kubernetes_io_name: 'line',
      });
      expect(scraped, job).toEqual({ __name__: 'line_security_events_total', kind: 'sign-in' });
    }
  });

  it('is never probed through a blackbox exporter or a Pushgateway, neither of which runs here', async () => {
    const jobs = await scrapeJobs();
    expect(jobs['kubernetes-services']?.enabled).toBe(false);
    expect(jobs['prometheus-pushgateway']?.enabled).toBe(false);
  });
});
