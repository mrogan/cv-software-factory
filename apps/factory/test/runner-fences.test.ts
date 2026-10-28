import { describe, expect, it } from 'vitest';
import type { Step } from '../../runner/src/step.ts';
import { agentJob, prepareJob } from '../src/runners/jobs.ts';
import { type Manifest, rendered } from './deploy.ts';

/**
 * The runners' fences as each profile renders them (ADR 0008, spec 6 guardrail 6): everything in `runners` is denied
 * both ways; the agent pod reaches the gateway and the line's handback in `factory`, and nothing else, not even DNS;
 * the prepare pod reaches DNS and 443 on public addresses alone; and of all the cluster's fences, only the gateway's
 * and the line's let a runner in, the agent pod alone. The pods are labelled as the line makes them
 * (runners/jobs.ts). `make egress` shows the same on the cluster.
 */
type Labels = Record<string, string>;
interface Selector {
  matchLabels?: Labels;
  matchExpressions?: unknown[];
}
interface Peer {
  namespaceSelector?: Selector;
  podSelector?: Selector;
  ipBlock?: { cidr: string; except?: string[] };
}
interface Rule {
  ports?: { protocol?: string; port?: number }[];
}
type Policy = Manifest & {
  kind: 'NetworkPolicy';
  metadata: { name: string; namespace: string };
  spec: {
    podSelector: Selector;
    policyTypes: string[];
    ingress?: (Rule & { from?: Peer[] })[];
    egress?: (Rule & { to?: Peer[] })[];
  };
};

/** The addresses the prepare pod may not reach: the cluster's, the local network's, link-local and the host's. */
const PRIVATE = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '100.64.0.0/10', '0.0.0.0/8'];

const STEP: Step = { agent: 'coder', repository: 'r', commit: 'c', prompt: 'p', maxTurns: 1 };
const NAMES = { job: 'coder-1-1-1', workItem: '1' };
const SETTINGS = { image: 'runner', deadlineSeconds: 60, gatewayUrl: '', handbackUrl: '', token: '', hosts: [] };
const AGENT = agentJob(NAMES, STEP, SETTINGS).spec.template.metadata.labels as Labels;
const PREPARE = prepareJob(NAMES, STEP, SETTINGS).spec.template.metadata.labels as Labels;

/** Whether a selector picks out labels; one this test cannot read is refused rather than guessed at. */
function selects(selector: Selector | undefined, labels: Labels): boolean {
  if (selector?.matchExpressions?.length) throw new Error('This test reads matchLabels alone');
  return Object.entries(selector?.matchLabels ?? {}).every(([key, value]) => labels[key] === value);
}

const NAMESPACE = 'kubernetes.io/metadata.name';
/** A peer and its ports, in a line: `factory/gateway TCP/8080`. */
const reach = (peer: Peer, rule: Rule) => {
  const where = peer.ipBlock
    ? `${peer.ipBlock.cidr} except ${(peer.ipBlock.except ?? []).join(' ')}`
    : `${peer.namespaceSelector?.matchLabels?.[NAMESPACE] ?? '(own namespace)'}/${Object.values(peer.podSelector?.matchLabels ?? {}).join(',') || '*'}`;
  return `${where} ${(rule.ports ?? []).map((p) => `${p.protocol ?? 'TCP'}/${p.port}`).join(' ')}`.trim();
};

/** Every place a pod with these labels in `runners` may reach, from each policy that selects it. */
const egressOf = (policies: Policy[], labels: Labels) =>
  policies
    .filter((p) => selects(p.spec.podSelector, labels))
    .flatMap((p) => (p.spec.egress ?? []).flatMap((rule) => (rule.to ?? []).map((peer) => reach(peer, rule))));

const profiles = () => {
  const byOverlay = new Map<string, Policy[]>();
  for (const { overlay, manifest } of rendered<Policy>()) {
    if (manifest.kind !== 'NetworkPolicy') continue;
    byOverlay.set(overlay, [...(byOverlay.get(overlay) ?? []), manifest]);
  }
  return [...byOverlay];
};

describe('the runners’ fences, in every profile', () => {
  const all = profiles();

  it('are rendered for every profile', () => {
    expect(all.map(([overlay]) => overlay)).toContain('local');
    expect(AGENT['factory.mrogan.dev/runner']).toBe('agent');
    expect(PREPARE['factory.mrogan.dev/runner']).toBe('prepare');
  });

  it('deny everything in runners, both ways, and let nothing in', () => {
    for (const [overlay, policies] of all) {
      const runners = policies.filter((p) => p.metadata.namespace === 'runners');
      const denyAll = runners.filter(
        (p) => Object.keys(p.spec.podSelector).length === 0 && !p.spec.ingress?.length && !p.spec.egress?.length,
      );
      expect(
        denyAll.map((p) => p.spec.policyTypes.sort()),
        overlay,
      ).toEqual([['Egress', 'Ingress']]);
      expect(
        runners.filter((p) => p.spec.ingress?.length),
        overlay,
      ).toEqual([]);
    }
  });

  it('let the agent pod reach the gateway and the line’s handback alone, with no DNS', () => {
    for (const [overlay, policies] of all) {
      const runners = policies.filter((p) => p.metadata.namespace === 'runners');
      expect(egressOf(runners, AGENT), overlay).toEqual(['factory/gateway TCP/8080', 'factory/line TCP/8081']);
    }
  });

  it('let the prepare pod reach DNS, and 443 on public addresses, alone', () => {
    for (const [overlay, policies] of all) {
      const runners = policies.filter((p) => p.metadata.namespace === 'runners');
      expect(egressOf(runners, PREPARE).sort(), overlay).toEqual(
        ['kube-system/kube-dns UDP/53 TCP/53', `0.0.0.0/0 except ${PRIVATE.join(' ')} TCP/443`].sort(),
      );
    }
  });

  it('are crossed only into the gateway and the line, by the agent pod alone, on the ports it reaches', () => {
    for (const [overlay, policies] of all) {
      const fromRunners = policies.flatMap((p) =>
        (p.spec.ingress ?? []).flatMap((rule) =>
          (rule.from ?? [])
            .filter((peer) => peer.namespaceSelector && selects(peer.namespaceSelector, { [NAMESPACE]: 'runners' }))
            .map((peer) => ({
              to: `${p.metadata.namespace}/${Object.values(p.spec.podSelector.matchLabels ?? {}).join(',')}`,
              ports: (rule.ports ?? []).map((port) => `${port.protocol ?? 'TCP'}/${port.port}`),
              agent: selects(peer.podSelector, AGENT),
              prepare: selects(peer.podSelector, PREPARE),
            })),
        ),
      );
      expect(fromRunners, overlay).toEqual([
        { to: 'factory/gateway', ports: ['TCP/8080'], agent: true, prepare: false },
        { to: 'factory/line', ports: ['TCP/8081'], agent: true, prepare: false },
      ]);
    }
  });
});

describe('reading a fence', () => {
  it('selects by every label a selector names, and refuses an expression', () => {
    expect(selects({}, AGENT)).toBe(true);
    expect(selects({ matchLabels: { 'factory.mrogan.dev/runner': 'agent' } }, AGENT)).toBe(true);
    expect(selects({ matchLabels: { 'factory.mrogan.dev/runner': 'agent' } }, PREPARE)).toBe(false);
    expect(() => selects({ matchExpressions: [{ key: 'a', operator: 'Exists' }] }, AGENT)).toThrow();
  });
});
