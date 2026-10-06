/** A dependency update that passed every gate, and that the canary caught and rolled back on its own. */
import { commitFor, digestFor, Item } from '../build.ts';

export default new Item('1276', '2026-10-02T08:10:00+01:00')
  .at('0:00', 'work-item.opened', 'dependabot', 'Dependabot proposed @opentelemetry/sdk-node 0.230.1', {
    kind: 'dependency-update',
    title: '@opentelemetry/sdk-node 0.230.1',
    sample: true,
    category: 'dependency',
    dependency: { name: '@opentelemetry/sdk-node', ecosystem: 'npm', from: '0.222.0', to: '0.230.1', security: false },
  })
  .at('0:02', 'pull-request.pushed', 'dependabot', 'Dependabot opened PR #1277: sdk-node 0.222.0 → 0.230.1', {
    number: 1277,
    title: 'chore(deps): bump @opentelemetry/sdk-node from 0.222.0 to 0.230.1',
    branch: 'dependabot/npm_and_yarn/opentelemetry/sdk-node-0.230.1',
    attempt: 1,
    testsFirst: false,
    files: [
      { path: 'package.json', added: 1, removed: 1 },
      { path: 'pnpm-lock.yaml', added: 64, removed: 58 },
    ],
  })
  .gates('0:10', { pullRequest: 1277 })
  .calls('reviewer', '3:00', '5:00', { calls: 2, input: 52_000, output: 2_400, cached: 0.5 })
  .at('5:10', 'review.submitted', 'reviewer', 'Approved; a dependency change, so it waits for Martin', {
    pullRequest: 1277,
    verdict: 'approved',
    note: 'Eight minor releases at once, with a new default for how spans are batched. Nothing in the app overrides it.',
    findings: [],
  })
  .at('5:11', 'hold.started', 'factory', 'Waiting for Martin: dependency changes carry a risk tag', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'A dependency change carries a risk tag, so it waits for Martin to approve the merge.',
  })
  .at('9:00', 'hold.answered', 'martin', 'Martin approved the merge', { decision: 'approved' })
  .at('9:05', 'pull-request.merged', 'factory', 'PR #1277 merged', {
    number: 1277,
    commit: commitFor('1276/merge'),
    by: 'factory',
  })
  .at('12:30', 'release.started', 'rollouts', 'v0.9.1 signed and admitted; canary at 5%', {
    version: 'v0.9.1',
    previous: 'v0.9.0',
    digest: digestFor('v0.9.1'),
    signed: true,
    admitted: true,
  })
  .at('12:40', 'canary.stepped', 'rollouts', 'Canary at 5%', {
    version: 'v0.9.1',
    weight: 5,
    analysis: {
      errorRate: { canary: 0.0022, baseline: 0.0021 },
      p99Ms: { canary: 140, baseline: 138 },
      journeys: { canary: [6, 6], baseline: [24, 24] },
    },
  })
  .at('15:54', 'release.rolled-back', 'rollouts', 'Rolled back: canary p99 412 ms against 139 ms on the baseline', {
    version: 'v0.9.1',
    restored: 'v0.9.0',
    weight: 5,
    reason: 'p99 latency on the canary rose to three times the baseline’s',
    analysis: {
      metric: 'p99 latency',
      unit: 'ms',
      stepSeconds: 20,
      canary: [140, 168, 214, 262, 318, 364, 396, 412, 409, 411, null, null, null, null],
      baseline: [138, 141, 137, 139, 140, 138, 142, 139, 137, 140, 138, 139, 141, 139],
      at: 10,
    },
  })
  .at('15:55', 'work-item.closed', 'factory', 'Closed: rolled back', {
    outcome: 'rolled-back',
    reason: 'The canary rolled it back; 95% of traffic stayed on v0.9.0 throughout',
  })
  .at('15:56', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'OpenTelemetry SDK 0.230, rolled back by the canary',
    description:
      'Every gate passed. At 5% of traffic the canary’s p99 latency tripled, and it rolled itself back in under four minutes.',
    story:
      'Dependabot proposed @opentelemetry/sdk-node 0.230.1, eight minor releases ahead. Every required check passed and the reviewer approved, and as a dependency change it waited for Martin, who approved it too. At 5% of traffic, the canary’s p99 latency climbed to three times the baseline’s. Argo Rollouts compared the two, rolled the canary back on its own and kept the series it compared. Only that 5% of traffic ever saw it.',
  });
