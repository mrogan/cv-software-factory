import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

/**
 * The readers of telemetry as deploy/ declares them (#348): each names the pods it reaches in `telemetry`, as `make
 * egress` shows on the cluster, with a stranger there that no reader reaches.
 */
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));

interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string> };
  podSelector?: { matchLabels?: Record<string, string> };
}
interface Rule {
  to?: Peer[];
  ports?: { protocol: string; port: number }[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: {
    podSelector?: { matchLabels?: Record<string, string> };
    egress?: Rule[];
  };
}

async function manifests(): Promise<Manifest[]> {
  const files = (await readdir(join(DEPLOY, 'base'), { recursive: true })).filter((f) => f.endsWith('.yaml'));
  const all: Manifest[] = [];
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(join(DEPLOY, 'base', file), 'utf-8'))) {
      const manifest = doc.toJS() as Manifest | null;
      if (manifest?.kind) all.push(manifest);
    }
  }
  return all;
}

/** Each rule of the factory's policies that reaches into `telemetry`: the policy, the pods it names, the ports. */
async function intoTelemetry() {
  return (await manifests())
    .filter((m) => m.kind === 'NetworkPolicy' && (m.metadata?.namespace ?? 'factory') === 'factory')
    .flatMap((policy) =>
      (policy.spec?.egress ?? []).flatMap((rule) =>
        (rule.to ?? [])
          .filter((peer) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'telemetry')
          .map((peer) => ({
            policy: policy.metadata?.name,
            pods: peer.podSelector,
            ports: (rule.ports ?? []).map((p) => p.port),
          })),
      ),
    );
}

describe('the factory’s reach into telemetry', () => {
  it('names the pods it reaches, never the whole namespace', async () => {
    const rules = await intoTelemetry();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.filter(({ pods }) => Object.keys(pods?.matchLabels ?? {}).length === 0)).toEqual([]);
  });
});
