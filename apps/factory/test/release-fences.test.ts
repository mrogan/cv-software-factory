import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

/** The release's fences as deploy/ declares them: who may change a Rollout, and what the analysis Job may reach. */
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));

interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  rules?: { apiGroups?: string[]; resources?: string[]; verbs?: string[] }[];
  roleRef?: { kind: string; name: string };
  spec?: Record<string, unknown>;
}

/** Every manifest under deploy/, from every YAML file. */
async function manifests(): Promise<{ file: string; manifest: Manifest }[]> {
  const files = (await readdir(DEPLOY, { recursive: true })).filter((f) => f.endsWith('.yaml'));
  const all: { file: string; manifest: Manifest }[] = [];
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(join(DEPLOY, file), 'utf-8'))) {
      const manifest = doc.toJS() as Manifest | null;
      if (manifest?.kind) all.push({ file, manifest });
    }
  }
  return all;
}

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
