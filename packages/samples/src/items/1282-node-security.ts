/** A security release of the base image: the scan's high findings gone, and no page changed. */
import { commitFor, digestFor, Item } from '../build.ts';

const SCAN = {
  before: { critical: 0, high: 2, medium: 5, low: 11 },
  after: { critical: 0, high: 0, medium: 3, low: 9 },
};

export default new Item('1282', '2026-10-02T11:30:00+01:00')
  .at('0:00', 'work-item.opened', 'dependabot', 'Dependabot proposed Node.js 24.21.1, a security release', {
    kind: 'dependency-update',
    title: 'Node.js 24.21.1',
    sample: true,
    category: 'security',
    dependency: { name: 'Node.js base image', ecosystem: 'docker', from: '24.21.0', to: '24.21.1', security: true },
  })
  .at('0:02', 'pull-request.pushed', 'dependabot', 'Dependabot opened PR #1283: node 24.21.0 → 24.21.1', {
    number: 1283,
    title: 'chore(deps): bump node from 24.21.0 to 24.21.1',
    branch: 'dependabot/docker/node-24.21.1',
    attempt: 1,
    testsFirst: false,
    files: [
      { path: 'Dockerfile', added: 1, removed: 1 },
      { path: 'mise.toml', added: 1, removed: 1 },
    ],
  })
  .gates('0:10', {
    pullRequest: 1283,
    details: { 'Image scan': { summary: 'No critical or high findings; two high findings fewer', findings: SCAN } },
  })
  .calls('reviewer', '3:00', '5:20', { calls: 2, input: 31_000, output: 1_700, cached: 0.5 })
  .at('5:30', 'review.submitted', 'reviewer', 'Approved; a dependency change, so it waits for Martin', {
    pullRequest: 1283,
    verdict: 'approved',
    comments: 0,
    note: 'A patch release with two security fixes and no other change.',
  })
  .at('5:31', 'hold.started', 'factory', 'Waiting for Martin: dependency changes carry a risk tag', {
    stage: 'review',
    kind: 'approval',
    reason: 'A dependency change carries a risk tag, so it waits for Martin to approve the merge.',
  })
  .at('8:40', 'hold.answered', 'martin', 'Martin approved the merge', { decision: 'approved' })
  .at('8:45', 'pull-request.merged', 'factory', 'PR #1283 merged', {
    number: 1283,
    commit: commitFor('1282/merge'),
    by: 'factory',
  })
  .at('11:00', 'release.started', 'rollouts', 'v0.9.2 signed and admitted; canary at 25%', {
    version: 'v0.9.2',
    previous: 'v0.9.0',
    digest: digestFor('v0.9.2'),
    signed: true,
    admitted: true,
  })
  .at('12:30', 'canary.stepped', 'rollouts', 'Canary at 25%: every check passing', {
    version: 'v0.9.2',
    weight: 25,
    analysis: {
      errorRate: { canary: 0.002, baseline: 0.0021 },
      p99Ms: { canary: 131, baseline: 133 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  })
  .at('15:10', 'release.promoted', 'rollouts', 'v0.9.2 promoted to 100%', { version: 'v0.9.2', previous: 'v0.9.0' })
  .verify('22:00', 'Every page matches v0.9.0, to the pixel', {
    check: 'Every page compared with v0.9.0',
    against: 'v0.9.0',
    version: 'v0.9.2',
  })
  .at('22:01', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'No high findings, and every page matches the version before',
  })
  .at('22:02', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Node.js 24.21.1 security release',
    description:
      'The base image moved to Node.js 24.21.1. The image scan’s two high findings are gone, and no page changed.',
    story:
      'Dependabot moved the app’s base image to the Node.js 24.21.1 security release. The image scan found two high-severity findings in the old image and none in the new one. The reviewer approved and, as a dependency change, it waited for Martin, who approved it. After rollout every page matched its screenshot from the version before, to the pixel.',
  });
