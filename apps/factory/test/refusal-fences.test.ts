import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { GUARDED_NAMESPACES, KYVERNO_EVENTS } from '../src/line/refusals.ts';
import { DEPLOY, manifests as deployManifests } from './deploy.ts';

/**
 * The fences around the refusals the line records for mechanisms with no role in the store (deviation 5, 7), as
 * deploy/ declares them: the GitHub worker's signing key, read by its pod alone; its public half, read by the line; and
 * the line's read of admission control's denials, which is a list of Events in the guarded namespaces and Kyverno's,
 * and nothing more.
 */
interface Container {
  name: string;
  env?: { name: string; value?: string; valueFrom?: Record<string, unknown> }[];
  envFrom?: unknown[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  rules?: unknown[];
  roleRef?: { apiGroup?: string; kind?: string; name?: string };
  subjects?: unknown[];
  spec?: {
    template?: {
      spec: { automountServiceAccountToken?: boolean; containers: Container[]; initContainers?: Container[] };
    };
  };
}

const manifests = () => deployManifests<Manifest>();
const SECRET = 'refusal-signing-key';
const CONFIG_MAP = 'refusal-key';

const deployment = async (name: string) => {
  const found = (await manifests()).find(
    ({ manifest }) => manifest.kind === 'Deployment' && manifest.metadata?.name === name,
  );
  if (!found?.manifest.spec?.template) throw new Error(`No ${name} Deployment`);
  return { ...found, pod: found.manifest.spec.template };
};

describe('the GitHub worker’s signing key', () => {
  it('is taken by the GitHub worker alone, optional, into its one container', async () => {
    const { file, namespace, pod } = await deployment('github');
    expect([file, namespace]).toEqual(['base/factory/github.yaml', 'factory']);
    const [container, ...others] = pod.spec.containers;
    expect(others).toEqual([]);
    expect(container?.env?.find((e) => e.name === 'REFUSAL_SIGNING_KEY')).toEqual({
      name: 'REFUSAL_SIGNING_KEY',
      valueFrom: { secretKeyRef: { name: SECRET, key: 'private-key', optional: true } },
    });
    // No token for the Kubernetes API, where a Secret could be read.
    expect(pod.spec.automountServiceAccountToken).toBe(false);
  });

  it('is named by nothing else in deploy/: no other pod mounts it, or takes it into its environment', async () => {
    const naming = (await manifests()).filter(({ manifest }) => JSON.stringify(manifest).includes(SECRET));
    expect(naming.map(({ file, manifest }) => `${file} ${manifest.kind}/${manifest.metadata?.name}`)).toEqual([
      'base/factory/github.yaml Deployment/github',
    ]);
  });

  it('has its public half read by the line, from refusal-key, and by nothing that could sign', async () => {
    const { pod } = await deployment('line');
    const env = pod.spec.containers.find((c) => c.name === 'line')?.env ?? [];
    expect(env.find((e) => e.name === 'REFUSAL_PUBLIC_KEY')).toEqual({
      name: 'REFUSAL_PUBLIC_KEY',
      valueFrom: { configMapKeyRef: { name: CONFIG_MAP, key: 'public-key', optional: true } },
    });
    const reading = (await manifests()).filter(({ manifest }) =>
      JSON.stringify(manifest).includes(`"name":"${CONFIG_MAP}"`),
    );
    expect(reading.map(({ file }) => file)).toEqual(['base/factory/line.yaml']);
  });
  it('is in no manifest: make refusal-key makes both, through stdin, and make up runs it', async () => {
    const made = (await manifests()).filter(
      ({ manifest }) =>
        ['Secret', 'ConfigMap'].includes(manifest.kind ?? '') &&
        [SECRET, CONFIG_MAP].includes(manifest.metadata?.name ?? ''),
    );
    expect(made).toEqual([]);
    const makefile = await readFile(`${DEPLOY}../Makefile`, 'utf-8');
    expect(makefile).toContain(`create secret generic ${SECRET} --from-file=private-key=/dev/stdin`);
    expect(makefile).toContain(`create configmap ${CONFIG_MAP} --from-file=public-key=/dev/stdin`);
    expect(makefile).toMatch(/^\t@\$\(MAKE\) --no-print-directory refusal-key$/m);
  });
});

describe('the line’s read of admission control’s denials', () => {
  const NAMESPACES = [...GUARDED_NAMESPACES, KYVERNO_EVENTS].sort();

  it('is one Role in each guarded namespace and in Kyverno’s: list Events, and nothing else', async () => {
    const roles = (await manifests()).filter(
      ({ manifest }) => manifest.kind === 'Role' && manifest.metadata?.name === 'line-reads-admission',
    );
    expect(roles.map(({ namespace }) => namespace).sort()).toEqual(NAMESPACES);
    for (const { manifest, file } of roles) {
      expect(file).toBe('base/line-reads-admission/roles.yaml');
      // List, as the line polls: never get, watch, or write, and no other kind.
      expect(manifest.rules).toEqual([{ apiGroups: [''], resources: ['events'], verbs: ['list'] }]);
    }
  });

  it('is bound to the line’s own service account alone, in each', async () => {
    const bound = (await manifests()).filter(({ manifest }) => manifest.roleRef?.name === 'line-reads-admission');
    expect(bound.map(({ namespace }) => namespace).sort()).toEqual(NAMESPACES);
    for (const { manifest } of bound) {
      expect(manifest.kind).toBe('RoleBinding');
      expect(manifest.roleRef).toEqual({
        apiGroup: 'rbac.authorization.k8s.io',
        kind: 'Role',
        name: 'line-reads-admission',
      });
      expect(manifest.subjects).toEqual([{ kind: 'ServiceAccount', name: 'line', namespace: 'factory' }]);
    }
  });

  it('is brought in with the line, by the profile that pins its image', async () => {
    const component = await readFile(`${DEPLOY}overlays/local/factory-image/kustomization.yaml`, 'utf-8');
    expect(component).toContain('- ../../../base/line-reads-admission');
  });
});
