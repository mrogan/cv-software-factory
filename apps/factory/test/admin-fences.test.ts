import { describe, expect, it } from 'vitest';
import { manifests as deployManifests } from './deploy.ts';

/**
 * The admin service's fences as deploy/ declares them (milestone 7): the browser reaches it under /admin/ on the
 * console's host, the console's server never receives the session cookie, and only the ingress controller reaches the
 * admin service, which is why it may believe the forwarded headers that come from the pod network.
 */
interface Backend {
  service?: { name?: string; port?: { name?: string } };
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
  spec?: {
    rules?: { host?: string; http?: { paths?: { path?: string; backend?: Backend }[] } }[];
    headers?: { customRequestHeaders?: Record<string, string> };
    podSelector?: Selector;
    ingress?: { from?: unknown[]; ports?: unknown[] }[];
    template?: {
      metadata?: { labels?: Record<string, string> };
      spec?: { containers?: { env?: { name: string; value?: string }[] }[] };
    };
    namespaceResourceWhitelist?: { group: string; kind: string }[];
    matchConstraints?: { resourceRules?: { apiGroups?: string[]; resources?: string[] }[] };
    variables?: { name: string; expression: string }[];
    validationActions?: string[];
  };
}

interface Selector {
  matchLabels?: Record<string, string>;
  matchExpressions?: { key: string; operator: string; values?: string[] }[];
}

const manifests = () => deployManifests<Manifest>();

/** Whether a label selector picks a pod with these labels, for the operators deploy/ uses; any other throws. */
function selects(selector: Selector, labels: Record<string, string>): boolean {
  const byLabel = Object.entries(selector.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
  return (
    byLabel &&
    (selector.matchExpressions ?? []).every(({ key, operator, values = [] }) => {
      if (operator === 'In') return values.includes(labels[key] ?? '');
      if (operator === 'NotIn') return !values.includes(labels[key] ?? '');
      if (operator === 'Exists') return key in labels;
      if (operator === 'DoesNotExist') return !(key in labels);
      throw new Error(`The selector simulation does not know ${operator}`);
    })
  );
}
const MIDDLEWARES = 'traefik.ingress.kubernetes.io/router.middlewares';
const TRAEFIK = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'traefik' } },
};

const ingresses = async () => (await manifests()).filter(({ manifest }) => manifest.kind === 'Ingress');
const routesTo = (manifest: Manifest, service: string) =>
  (manifest.spec?.rules ?? []).flatMap((rule) =>
    (rule.http?.paths ?? []).filter((path) => path.backend?.service?.name === service).map((path) => path.path),
  );

describe('the console’s server', () => {
  it('is sent no cookie: every route to it removes the header', async () => {
    const toConsole = (await ingresses()).filter(({ manifest }) => routesTo(manifest, 'console').length > 0);
    expect(toConsole.length).toBeGreaterThan(0);
    for (const { manifest, file } of toConsole) {
      expect(manifest.metadata?.annotations?.[MIDDLEWARES]?.split(','), file).toContain(
        'factory-console-no-cookies@kubernetescrd',
      );
    }
    const middleware = (await manifests()).find(
      ({ manifest }) => manifest.kind === 'Middleware' && manifest.metadata?.name === 'console-no-cookies',
    );
    // Traefik removes a request header set to the empty string.
    expect(middleware?.manifest.spec?.headers?.customRequestHeaders).toEqual({ Cookie: '' });
  });
});

describe('the admin service', () => {
  it('is reached under /admin/ on the console’s host, and only there', async () => {
    const toAdmin = (await ingresses()).flatMap(({ manifest }) =>
      (manifest.spec?.rules ?? []).flatMap((rule) =>
        (rule.http?.paths ?? [])
          .filter((path) => path.backend?.service?.name === 'admin')
          .map((path) => `${rule.host}${path.path}`),
      ),
    );
    expect(toAdmin).toEqual(['console.localhost/admin/']);
  });

  it('lets in the ingress controller alone, so the forwarded headers it trusts come from Traefik', async () => {
    const all = await manifests();
    const deployment = all.find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'admin',
    );
    const labels = deployment?.manifest.spec?.template?.metadata?.labels;
    expect(labels?.['app.kubernetes.io/name']).toBe('admin');
    const policies = all.filter(
      ({ manifest, namespace }) =>
        manifest.kind === 'NetworkPolicy' &&
        namespace === 'factory' &&
        selects(manifest.spec?.podSelector ?? {}, labels ?? {}),
    );
    const from = policies.flatMap(({ manifest }) => (manifest.spec?.ingress ?? []).flatMap((rule) => rule.from ?? []));
    expect(from).toEqual([TRAEFIK]);
  });

  it('serves the console’s origin, and trusts forwarded headers from the pod network only', async () => {
    const deployment = (await manifests()).find(
      ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === 'admin',
    );
    const env = Object.fromEntries(
      (deployment?.manifest.spec?.template?.spec?.containers?.[0]?.env ?? []).map((e) => [e.name, e.value]),
    );
    expect(env.ADMIN_ORIGIN).toBe('https://console.localhost:8443');
    expect(env.ADMIN_TRUSTED_PROXIES).toBe('10.42.0.0/16');
  });
});

describe('the app’s routes', () => {
  // The app's repository, which agents write to, may make Traefik routes in `website`. A route on the console's host
  // would take Martin's session cookie, so admission lets a route there name the app's hosts alone.
  it('are the only routes the app’s repository may make, and the admission policy holds them', async () => {
    const all = await manifests();
    const project = all.find(({ manifest }) => manifest.kind === 'AppProject' && manifest.metadata?.name === 'website');
    const routing = (project?.manifest.spec?.namespaceResourceWhitelist ?? []).filter(
      ({ group, kind }) =>
        ['traefik.io', 'traefik.containo.us', 'networking.k8s.io', 'gateway.networking.k8s.io'].includes(group) &&
        kind !== 'Middleware' &&
        kind !== 'TraefikService',
    );
    expect(routing).toEqual([{ group: 'traefik.io', kind: 'IngressRoute' }]);
    const policy = all.find(
      ({ manifest }) => manifest.kind === 'ValidatingPolicy' && manifest.metadata?.name === 'routes',
    );
    expect(policy?.file).toBe('base/admission/website/routes.yaml');
    expect(policy?.manifest.spec?.validationActions).toEqual(['Deny']);
    expect(policy?.manifest.spec?.matchConstraints?.resourceRules).toEqual([
      expect.objectContaining({ apiGroups: ['traefik.io'], resources: ['ingressroutes'] }),
    ]);
    const hosts = policy?.manifest.spec?.variables?.find((v) => v.name === 'hosts')?.expression ?? '';
    expect(hosts).not.toMatch(/console/);
  });
});
