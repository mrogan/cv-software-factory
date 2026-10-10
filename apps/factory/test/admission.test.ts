import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';
import { REPOSITORIES } from '../src/github/config.ts';
import { GITHUB_ACTIONS, pipeline } from '../src/github/signatures.ts';

/** Admission control as deploy/base/admission declares it (ADR 0010), and the refusals the cluster gave. */
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const read = (path: string) => readFile(join(DEPLOY, path), 'utf-8');

interface Op {
  op: string;
  path: string;
  value: unknown;
}

/** The strings an expression lists: `['a', 'b']`. */
const listed = (expression: unknown) => [...String(expression ?? '[]').matchAll(/'([^']+)'/g)].map((m) => m[1]);

/**
 * One copy of the image policy: the namespaces it guards, the repositories of ours it admits, by which identity, and
 * the images it names from other registries.
 */
async function copy(name: 'factory' | 'website') {
  const kustomization = parse(await read(`base/admission/${name}/kustomization.yaml`)) as {
    namePrefix: string;
    patches: { patch: string }[];
  };
  const ops = kustomization.patches.flatMap((p) => parse(p.patch) as Op[]);
  const value = (path: string) => ops.find((o) => o.path === path)?.value;
  return {
    policy: `${kustomization.namePrefix}images`,
    namespaces: value('/spec/matchConstraints/namespaceSelector/matchExpressions/0/values') as string[],
    allowed: listed(value('/spec/variables/0/expression')),
    factory: listed(value('/spec/variables/1/expression')),
    website: listed(value('/spec/variables/2/expression')),
  };
}

const policy = async () =>
  parse(await read('base/admission/images/policy.yaml')) as {
    spec: {
      attestors: { name: string; cosign: { keyless: { identities: Record<string, string>[] } } }[];
      variables: { name: string; expression: string }[];
      validationActions: string[];
    };
  };

/** Every image named anywhere in a manifest: a container's `image`, an image volume's `reference`, kustomize's. */
function named(node: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(node)) for (const item of node) named(item, into);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'image' && typeof value === 'string') into.add(value);
      else if (key === 'image' && value && typeof value === 'object' && 'reference' in value)
        into.add(String(value.reference));
      else if (key === 'newName' && typeof value === 'string') into.add(value);
      else named(value, into);
    }
  }
  return into;
}

/** Every image the manifests in these directories, and these files, name that is not one of ours. */
async function thirdParty(dirs: string[], files: string[]) {
  for (const dir of dirs) {
    files.push(...(await readdir(join(DEPLOY, dir))).filter((f) => f.endsWith('.yaml')).map((f) => join(dir, f)));
  }
  const images = new Set<string>();
  for (const file of files) for (const doc of parseAllDocuments(await read(file))) named(doc.toJS(), images);
  // A bare name (`factory`) is ours, pinned by the profile's kustomize `images:`.
  return [...images].filter((i) => i.includes('/') && !i.startsWith('ghcr.io/mrogan/')).sort();
}

/** Which of the policy's checks refuses each kept case. */
const REFUSED_BY: Record<string, string> = {
  unsigned: 'images must be signed by build.yml on main of the repository that builds them: ',
  'other-identity': "images must come from this project's GHCR, or be named by digest in the policy: ",
  misplaced: "images from this project's GHCR must be ones this namespace runs: ",
};

describe('admission control', () => {
  it("trusts each repository's build.yml on main, by its whole identity, as the deploy watch does", async () => {
    const { spec } = await policy();
    const identities = spec.attestors.flatMap((a) => a.cosign.keyless.identities);
    expect(identities).toEqual(
      REPOSITORIES.map((repo) => ({ issuer: GITHUB_ACTIONS, subject: pipeline(repo).identity })),
    );
    expect(spec.attestors.map((a) => a.name)).toEqual(['factory', 'website']);
    // The copies set the first three variables by position.
    expect(spec.variables.slice(0, 3).map((v) => v.name)).toEqual([
      'allowed',
      'factoryRepositories',
      'websiteRepositories',
    ]);
    // The images each attestor vouches for are its own repository's, and only those.
    const variable = (name: string) => spec.variables.find((v) => v.name === name)?.expression;
    expect(variable('factoryImages')).toContain('variables.factoryRepositories.exists(');
    expect(variable('websiteImages')).toContain('variables.websiteRepositories.exists(');
    const expression = variable('unsigned')?.replace(/\s+/g, ' ') ?? '';
    expect(expression).toMatch(/variables\.factoryImages\.filter\([^+]*\[attestors\.factory\]\)/);
    expect(expression).toMatch(/variables\.websiteImages\.filter\([^+]*\[attestors\.website\]\)/);
    expect(expression).not.toMatch(/factoryImages[^+]*attestors\.website|websiteImages[^+]*attestors\.factory/);
  });

  it('verifies the signature only: the deploy checks require the SBOM, which is too large to parse at admission', async () => {
    const source = await read('base/admission/images/policy.yaml');
    const { spec } = parse(source) as { spec: { attestations?: unknown[] } };
    expect(spec.attestations ?? []).toEqual([]);
    expect(source).not.toMatch(/verifyAttestationSignatures/);
  });

  it('guards every namespace the factory and the app run in; telemetry and Argo Rollouts run only their charts', async () => {
    const namespaces = parseAllDocuments(await read('base/namespaces.yaml')).map(
      (d) => (d.toJS() as { metadata: { name: string } }).metadata.name,
    );
    const guarded = [...(await copy('factory')).namespaces, ...(await copy('website')).namespaces];
    const charts = ['telemetry', 'argo-rollouts'];
    expect(guarded.sort()).toEqual(namespaces.filter((n) => !charts.includes(n)).sort());
  });

  it('admits in each namespace only the images of ours that run there', async () => {
    // The factory's namespaces: every image the profile pins from build.yml, and none of the app's.
    const pinned = [...named(parse(await read('overlays/local/factory-image/kustomization.yaml')), new Set())];
    pinned.push(...named(parse(await read('overlays/local/console-image/kustomization.yaml')), new Set()));
    const factory = await copy('factory');
    expect(factory.factory.sort()).toEqual(
      pinned.filter((i) => i.startsWith('ghcr.io/mrogan/cv-software-factory/')).sort(),
    );
    expect(factory.website).toEqual([]);
    // The app's namespace: the app, and the factory's browser for the analysis Job that walks a canary's journeys.
    const website = await copy('website');
    expect(website.factory).toEqual(['ghcr.io/mrogan/cv-software-factory/factory-browser']);
    expect(website.website).toEqual(['ghcr.io/mrogan/cv-worlds-worst-website']);
  });

  it('admits from another registry only the images the factory runs, each by digest', async () => {
    const factory = await copy('factory');
    expect(factory.allowed).toEqual(
      await thirdParty(
        ['base/postgres', 'base/factory', 'base/runners', 'base/migrate', 'base/console'],
        ['k3d/artifacts-copier.yaml'],
      ),
    );
    for (const image of factory.allowed) expect(image).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect((await copy('website')).allowed).toEqual([]);
  });

  it('refuses in every guarded namespace: nothing in deploy/ switches either copy to Audit', async () => {
    expect((await policy()).spec.validationActions).toEqual(['Deny']);
    // Only the policy sets its mode. The `try-the-line` skill switches `factory-images` to Audit on the cluster for a
    // run, and Argo CD puts it back; no manifest here does.
    const files = (await readdir(DEPLOY, { recursive: true })).filter(
      (f) => f.endsWith('.yaml') && f !== join('base', 'admission', 'images', 'policy.yaml'),
    );
    for (const file of files) expect(await read(file), file).not.toMatch(/validationActions/);
  });

  it("kept Kyverno's refusals in every guarded namespace (scripts/admission-refusals.sh)", async () => {
    const kept = JSON.parse(await read('test/admission-refusals.json')) as {
      namespace: string;
      case: string;
      image: string;
      outcome: string;
      message: string;
    }[];
    for (const { policy: name, namespaces } of [await copy('factory'), await copy('website')]) {
      for (const namespace of namespaces) {
        const refusals = kept.filter((r) => r.namespace === namespace);
        expect(refusals.map((r) => r.case).sort()).toEqual(['misplaced', 'other-identity', 'unsigned']);
        for (const refusal of refusals) {
          expect(refusal.outcome).toBe('refused');
          // A refusal names the policy, the check that refused it and the image.
          expect(refusal.message).toContain(`Policy ${name} failed: ${REFUSED_BY[refusal.case]}`);
          expect(refusal.message).toContain(refusal.image);
        }
      }
    }
  });
});
