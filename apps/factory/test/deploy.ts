import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

/**
 * deploy/ as the tests read it: its files as written, overlays too, not as `kustomize build` would render them, so an
 * overlay's own rules are checked as well as the base's.
 */
export const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));

/** Prometheus's server, as a network policy's peer: the one pod every fence around what it scrapes lets in. */
export const PROMETHEUS = {
  namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'telemetry' } },
  podSelector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus', 'app.kubernetes.io/component': 'server' } },
};

/** What every manifest has; each test names the rest of what it reads. */
export interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
}

/**
 * Every manifest under deploy/, from every YAML file, each with its file and its namespace: its directory's
 * kustomization's, or else its own.
 */
export async function manifests<M extends Manifest = Manifest>(): Promise<
  { file: string; namespace?: string; manifest: M }[]
> {
  const files = (await readdir(DEPLOY, { recursive: true })).filter((f) => f.endsWith('.yaml'));
  const namespaces = new Map<string, string | undefined>();
  for (const file of files.filter((f) => f.endsWith('kustomization.yaml'))) {
    const kustomization = parse(await readFile(join(DEPLOY, file), 'utf-8')) as { namespace?: string };
    namespaces.set(dirname(file), kustomization.namespace);
  }
  const all: { file: string; namespace?: string; manifest: M }[] = [];
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(join(DEPLOY, file), 'utf-8'))) {
      const manifest = doc.toJS() as M | null;
      if (!manifest?.kind) continue;
      const namespace = namespaces.get(dirname(file)) ?? manifest.metadata?.namespace;
      all.push({ file, manifest, ...(namespace ? { namespace } : {}) });
    }
  }
  return all;
}
