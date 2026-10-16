import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

/**
 * The readers of telemetry as deploy/ declares them (#348): each names the pods it reaches in `telemetry`, as `make
 * egress` shows on the cluster, with a stranger there that no reader reaches.
 */
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));

interface Peer {
  namespaceSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  podSelector?: { matchLabels?: Record<string, string>; matchExpressions?: unknown[] };
  ipBlock?: { cidr: string };
}
interface Rule {
  to?: Peer[];
  ports?: { protocol: string; port: number }[];
}
interface Manifest {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
  spec?: { egress?: Rule[] };
}

/** Every manifest under deploy/, overlays too, with its namespace: its own, or its directory's kustomization's. */
async function manifests(): Promise<{ namespace: string | undefined; manifest: Manifest }[]> {
  const files = (await readdir(DEPLOY, { recursive: true })).filter((f) => f.endsWith('.yaml'));
  const namespaces = new Map<string, string | undefined>();
  for (const file of files.filter((f) => f.endsWith('kustomization.yaml'))) {
    const kustomization = parse(await readFile(join(DEPLOY, file), 'utf-8')) as { namespace?: string };
    namespaces.set(dirname(file), kustomization.namespace);
  }
  const all: { namespace: string | undefined; manifest: Manifest }[] = [];
  for (const file of files) {
    for (const doc of parseAllDocuments(await readFile(join(DEPLOY, file), 'utf-8'))) {
      const manifest = doc.toJS() as Manifest | null;
      if (!manifest?.kind) continue;
      all.push({ manifest, namespace: namespaces.get(dirname(file)) ?? manifest.metadata?.namespace });
    }
  }
  return all;
}

/** The egress rules of the policies in `factory`, each peer on its own: the policy, the peer, the rule's ports. */
async function factoryEgress() {
  return (await manifests())
    .filter(({ manifest, namespace }) => manifest.kind === 'NetworkPolicy' && namespace === 'factory')
    .flatMap(({ manifest: policy }) =>
      (policy.spec?.egress ?? []).flatMap((rule) =>
        (rule.to ?? [{}]).map((peer) => ({
          policy: policy.metadata?.name,
          peer,
          ports: (rule.ports ?? []).map((p) => p.port),
        })),
      ),
    );
}

/** The rules that reach into `telemetry`: by its name, the pods named by their labels. */
async function intoTelemetry() {
  return (await factoryEgress())
    .filter(({ peer }) => peer.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] === 'telemetry')
    .map(({ policy, peer, ports }) => ({ policy, pods: peer.podSelector, ports }));
}

describe('the factory’s reach into telemetry', () => {
  it('names each namespace it reaches by name, and leaves none open by omission', async () => {
    // A rule with no peer reaches everywhere, and an empty or expression namespace selector reaches every namespace or
    // whichever match: each would take in `telemetry` unnamed. An address block is the line's, to the API server's port, or the local gateway's,
    // to LM Studio on the host.
    const open = (await factoryEgress()).filter(
      ({ peer }) =>
        Object.keys(peer).length === 0 ||
        (peer.namespaceSelector !== undefined && !peer.namespaceSelector.matchLabels?.['kubernetes.io/metadata.name']),
    );
    expect(open).toEqual([]);
    const blocks = (await factoryEgress()).filter(
      ({ peer }) => peer.ipBlock && !peer.ipBlock.cidr.startsWith('0.0.0.0'),
    );
    expect(new Set(blocks.map(({ policy, ports }) => `${policy} ${ports}`))).toEqual(
      new Set(['line 6443', 'gateway-local-models 1234']),
    );
  });

  it('names the pods it reaches there, each backend on its own port', async () => {
    const rules = await intoTelemetry();
    expect(rules.length).toBeGreaterThan(0);
    const backend = (pods: Peer['podSelector']) => pods?.matchLabels?.['app.kubernetes.io/name'];
    expect(rules.filter(({ pods }) => !backend(pods) || pods?.matchExpressions)).toEqual([]);
    const port: Record<string, number> = { prometheus: 9090, loki: 3100, tempo: 3200, 'opentelemetry-collector': 4318 };
    for (const { policy, pods, ports } of rules) {
      expect(ports, `${policy} to ${backend(pods)}`).toEqual([port[backend(pods) ?? '']]);
    }
    // Prometheus's server, and not Alertmanager, which carries the same name.
    for (const { pods } of rules.filter(({ pods }) => backend(pods) === 'prometheus')) {
      expect(pods?.matchLabels?.['app.kubernetes.io/component']).toBe('server');
    }
  });
});
