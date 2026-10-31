import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonical,
  differences,
  named,
  nameOf,
  PROFILE,
  policyHash,
  RECORDS,
  type RecordName,
  type Resource,
  taken,
} from '../../../scripts/policy-hash.ts';
import { DEPLOY, rendered } from './deploy.ts';

/**
 * The refusal records in deploy/test/, each held to the policies and Roles it was taken against: a record keeps their
 * hash (scripts/policy-hash.ts), and it must be the hash of what deploy/ renders now. So a policy or Role loosened, or
 * tightened, without its script run again against the cluster fails here, and the record never speaks for policies
 * that did not give its answers.
 */

const profile = () =>
  rendered<Resource>()
    .filter((r) => r.overlay === PROFILE)
    .map((r) => r.manifest);
const files = () => readdirSync(join(DEPLOY, 'test')).filter((f) => f.endsWith('.json'));
const record = (file: string) =>
  JSON.parse(readFileSync(join(DEPLOY, 'test', file), 'utf-8')) as { policyHash?: string; policies?: string[] };

describe('each refusal record', () => {
  const manifests = profile();

  it('is one the hash names objects for, and each it names objects for is kept, but egress.sh’s', () => {
    expect(
      files()
        .map((f) => f.replace(/\.json$/, ''))
        .sort(),
    ).toEqual(
      Object.keys(RECORDS)
        .filter((r) => r !== 'egress')
        .sort(),
    );
  });

  for (const file of files()) {
    const name = file.replace(/\.json$/, '') as RecordName;
    it(`${name} was taken against the policies deploy/ renders now`, () => {
      const kept = record(file);
      const now = taken(name, manifests);
      expect(kept.policies, 'the objects it names').toEqual(now.policies);
      expect(
        kept.policyHash,
        `${file} was taken against other policies: run its script again, against a cluster that runs these`,
      ).toBe(now.policyHash);
      expect(kept.policyHash).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it('names every Role bound to an account it asks as, in the namespace it asks in', () => {
    // As whom each record's script asks, and where; RBAC grants what any Role bound to the account does.
    const asks: Partial<Record<RecordName, { namespace: string; accounts: string[] }>> = {
      'rollout-refusals': { namespace: 'website', accounts: ['factory/admin'] },
      'flag-stages-refusals': { namespace: 'flagd', accounts: ['factory/admin', 'factory/line', 'flagd/flagd'] },
    };
    type Binding = Resource & {
      roleRef: { kind: string; name: string };
      subjects?: { kind: string; name: string; namespace?: string }[];
    };
    for (const [name, { namespace, accounts }] of Object.entries(asks)) {
      const binds = (b: Binding) =>
        b.subjects?.some((s) => s.kind === 'ServiceAccount' && accounts.includes(`${s.namespace}/${s.name}`));
      const bindings = (manifests as Binding[]).filter(
        (m) =>
          (m.kind === 'RoleBinding' && m.metadata?.namespace === namespace && binds(m)) ||
          (m.kind === 'ClusterRoleBinding' && binds(m)),
      );
      expect(bindings.length, name).toBeGreaterThan(0);
      const needed = bindings.flatMap((b) => [
        nameOf(b),
        `${b.roleRef.kind} ${b.roleRef.kind === 'Role' ? `${namespace}/` : ''}${b.roleRef.name}`,
      ]);
      const names = named(name as RecordName, manifests).map(nameOf);
      for (const n of needed) expect(names, name).toContain(n);
    }
  });

  it('fails when a policy it was taken against is loosened', () => {
    const loosened = structuredClone(manifests);
    const routes = loosened.find((m) => m.kind === 'ValidatingPolicy' && m.metadata?.name === 'website-routes') as
      | (Resource & { spec: { validations: unknown[] } })
      | undefined;
    if (!routes) throw new Error('No website-routes policy');
    routes.spec.validations = routes.spec.validations.slice(1);
    expect(taken('route-refusals', loosened).policyHash).not.toBe(record('route-refusals.json').policyHash);
    // A Role granted one more verb, too.
    const role = loosened.find((m) => m.kind === 'Role' && m.metadata?.name === 'admin-controls-release') as
      | (Resource & { rules: { verbs: string[] }[] })
      | undefined;
    role?.rules[0]?.verbs.push('delete');
    expect(taken('rollout-refusals', loosened).policyHash).not.toBe(record('rollout-refusals.json').policyHash);
  });
});

describe('the hash of a record’s policies', () => {
  const policy: Resource = {
    apiVersion: 'admissionregistration.k8s.io/v1',
    kind: 'ValidatingAdmissionPolicy',
    metadata: { name: 'p', annotations: { 'argocd.argoproj.io/sync-wave': '0' } },
    spec: { failurePolicy: 'Fail', validations: [{ expression: 'false' }] },
  };

  it('reads what deploy/ gives an object, and none of what the cluster adds', () => {
    const live: Resource = {
      ...policy,
      metadata: {
        name: 'p',
        uid: 'u',
        resourceVersion: '7',
        managedFields: [],
        annotations: { 'argocd.argoproj.io/tracking-id': 'root:x' },
      },
      status: { observedGeneration: 1 },
    };
    expect(canonical(live)).toEqual(canonical(policy));
    expect(canonical(policy)).toEqual({
      apiVersion: 'admissionregistration.k8s.io/v1',
      kind: 'ValidatingAdmissionPolicy',
      metadata: { name: 'p' },
      spec: { failurePolicy: 'Fail', validations: [{ expression: 'false' }] },
    });
    expect(policyHash([live])).toBe(policyHash([policy]));
  });

  it('is of the objects, whatever their order or their keys’, and changes with any field', () => {
    const other: Resource = { ...policy, metadata: { name: 'q' } };
    expect(policyHash([policy, other])).toBe(policyHash([other, policy]));
    const reordered = { spec: { validations: [{ expression: 'false' }], failurePolicy: 'Fail' }, ...policy };
    expect(policyHash([reordered])).toBe(policyHash([policy]));
    expect(
      policyHash([{ ...policy, spec: { failurePolicy: 'Ignore', validations: [{ expression: 'false' }] } }]),
    ).not.toBe(policyHash([policy]));
    expect(policyHash([{ ...policy, metadata: { name: 'p', namespace: 'n' } }])).not.toBe(policyHash([policy]));
    expect(policyHash([policy])).toMatch(/^[0-9a-f]{64}$/);
  });

  it('names a missing object rather than hashing without it', () => {
    expect(() => named('route-refusals', [policy])).toThrow(/ValidatingPolicy website-routes: 0 found/);
  });
});

describe('telling the live object from what deploy/ gives it', () => {
  const want = canonical({
    apiVersion: 'v1',
    kind: 'K',
    metadata: { name: 'n' },
    spec: { a: 1, list: [{ b: 'x' }], empty: {}, none: [] },
  });

  it('passes over what the cluster adds, and an empty field it leaves out', () => {
    expect(differences(want, { ...want, spec: { a: 1, list: [{ b: 'x', c: 2 }], defaulted: true } })).toEqual([]);
  });

  it('finds a field changed, one missing, and a list grown or shrunk', () => {
    expect(differences(want, { ...want, spec: { a: 2, list: [{ b: 'x' }] } })).toEqual(['/spec/a: 2, not 1']);
    expect(differences(want, { ...want, spec: { list: [{ b: 'x' }] } })).toEqual(['/spec/a: undefined, not 1']);
    expect(differences(want, { ...want, spec: { a: 1, list: [{ b: 'x' }, { b: 'y' }] } })).toEqual([
      '/spec/list: [{"b":"x"},{"b":"y"}]',
    ]);
    expect(differences(want, { ...want, spec: { a: 1, list: [] } })).toEqual(['/spec/list: []']);
  });
});
