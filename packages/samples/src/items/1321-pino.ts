/**
 * The wait for Martin's deploy, as the samples end: he merged Dependabot's update minutes after his deploy of #1314
 * started its canary, so it waits at Release for the next deploy pull request to carry it.
 */
import { commitFor, Item } from '../build.ts';

export default new Item('1321', '2026-10-06T12:30:00+01:00')
  .at('0:00', 'work-item.opened', 'dependabot', 'Dependabot proposed pino 10.5.0', {
    kind: 'dependency-update',
    title: 'pino 10.5.0',
    sample: true,
    category: 'dependency',
    dependency: { name: 'pino', ecosystem: 'npm', from: '10.4.0', to: '10.5.0', security: false },
  })
  .pushed('0:02', 'dependabot', 'Dependabot opened PR #1322: pino 10.4.0 → 10.5.0', {
    number: 1322,
    title: 'chore(deps): bump pino from 10.4.0 to 10.5.0',
    branch: 'dependabot/npm_and_yarn/pino-10.5.0',
    attempt: 1,
    testsFirst: false,
    files: [
      { path: 'package.json', added: 1, removed: 1 },
      { path: 'pnpm-lock.yaml', added: 11, removed: 11 },
    ],
  })
  .gates('0:10', { pullRequest: 1322 })
  .calls('reviewer', '3:00', '5:00', { calls: 2, input: 37_000, output: 1_800, cached: 0.5 })
  .at('5:10', 'review.submitted', 'reviewer', 'Review of PR #1322: Approved', {
    pullRequest: 1322,
    verdict: 'approved',
    note: 'A minor release: its changelog lists faster serialisers for errors, and nothing the app relies on changes.',
    findings: [],
  })
  .at('5:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1322 has passed its gates and review, and waits for Martin to merge it',
  })
  .at('2:51:00', 'pull-request.merged', 'martin', 'Martin merged PR #1322', {
    number: 1322,
    commit: commitFor('1321/merge'),
    by: 'martin',
  })
  .at('2:51:01', 'hold.started', 'factory', 'Waiting for a deploy pull request to carry the fix', {
    stage: 'release',
    kind: 'approval',
    cause: 'deploy',
    reason: 'The fix in pull request #1322 is merged, and waits for a deploy pull request to carry it to the shop',
  });
