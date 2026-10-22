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
    podSelector?: { matchLabels?: Record<string, string> };
    ingress?: { from?: unknown[]; ports?: unknown[] }[];
    template?: { spec?: { containers?: { env?: { name: string; value?: string }[] }[] } };
  };
}

const manifests = () => deployManifests<Manifest>();
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
    const policies = (await manifests()).filter(
      ({ manifest }) =>
        manifest.kind === 'NetworkPolicy' &&
        (manifest.spec?.podSelector?.matchLabels?.['app.kubernetes.io/name'] === 'admin' ||
          Object.keys(manifest.spec?.podSelector ?? {}).length === 0),
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
