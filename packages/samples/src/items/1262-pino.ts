/** A minor update from Dependabot: through every gate and the canary, and no page changed. */
import { commitFor, digestFor, Item } from '../build.ts';

export default new Item('1262', '2026-09-29T09:30:00+01:00')
  .at('0:00', 'work-item.opened', 'dependabot', 'Dependabot proposed pino 10.4.0', {
    kind: 'dependency-update',
    title: 'pino 10.4.0',
    sample: true,
    category: 'dependency',
    dependency: { name: 'pino', ecosystem: 'npm', from: '10.3.1', to: '10.4.0', security: false },
  })
  .at('0:02', 'pull-request.pushed', 'dependabot', 'Dependabot opened PR #1263: pino 10.3.1 → 10.4.0', {
    number: 1263,
    title: 'chore(deps): bump pino from 10.3.1 to 10.4.0',
    branch: 'dependabot/npm_and_yarn/pino-10.4.0',
    attempt: 1,
    testsFirst: false,
    files: [
      { path: 'package.json', added: 1, removed: 1 },
      { path: 'pnpm-lock.yaml', added: 9, removed: 9 },
    ],
  })
  .gates('0:20', { pullRequest: 1263 })
  .calls('reviewer', '2:40', '4:10', { calls: 2, input: 36_000, output: 1_900, cached: 0.5 })
  .at('4:20', 'review.submitted', 'reviewer', 'Approved; a dependency change, so it waits for Martin', {
    pullRequest: 1263,
    verdict: 'approved',
    note: 'A minor release: its changelog lists one fix to log rotation, which the app does not use.',
    findings: [],
  })
  .at('4:21', 'hold.started', 'factory', 'Waiting for Martin: dependency changes carry a risk tag', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'A dependency change carries a risk tag, so it waits for Martin to approve the merge.',
  })
  .at('11:05', 'hold.answered', 'martin', 'Martin approved the merge', { decision: 'approved' })
  .at('11:20', 'pull-request.merged', 'factory', 'PR #1263 merged', {
    number: 1263,
    commit: commitFor('1262/merge'),
    by: 'factory',
  })
  .at('14:30', 'release.started', 'rollouts', 'v0.8.4 signed and admitted; canary at 25%', {
    version: 'v0.8.4',
    previous: 'v0.8.3',
    digest: digestFor('v0.8.4'),
    signed: true,
    admitted: true,
  })
  .at('16:30', 'canary.stepped', 'rollouts', 'Canary at 25%: every check passing', {
    version: 'v0.8.4',
    weight: 25,
    analysis: {
      errorRate: { canary: 0.0021, baseline: 0.0022 },
      p99Ms: { canary: 133, baseline: 136 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  })
  .at('19:40', 'release.promoted', 'rollouts', 'v0.8.4 promoted to 100%', { version: 'v0.8.4', previous: 'v0.8.3' })
  .verify('23:10', 'Every page matches v0.8.3, to the pixel', {
    check: 'Every page compared with v0.8.3',
    against: 'v0.8.3',
    version: 'v0.8.4',
  })
  .at('23:11', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'Every page matches the version before',
  })
  .at('23:12', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'pino 10.4.0, and nothing to see',
    description:
      'Dependabot’s minor update to the logging library passed every gate and the canary. Every page matches the version before, to the pixel.',
    story:
      'Dependabot proposed pino 10.4.0, a minor release of the library the shop logs with. Every required check passed and the reviewer approved; as a dependency change it waited for Martin, who approved the merge. It went out as v0.8.4 behind a canary, and once it was on all traffic every page was compared with v0.8.3: not a pixel had moved.',
  });
