/**
 * A defect the log watcher saw, fixed in two passes and then reopened. The first fix went out in the same release as
 * #1304's, and Verify still saw the error from it, so the work went back to Plan by itself. The second fix cleared
 * it. A day later the same error came back from a release of Martin's own, and the ticket opened again.
 */
import type { Evidence } from '@software-factory/events';
import { commitFor, Item, type Step, traceFor } from '../build.ts';

/** The figures of v0.9.8's two steps, which carried this fix and #1304's. */
export const V098: Step[] = [
  {
    errorRate: { canary: 0.0021, baseline: 0.0022 },
    p99Ms: { canary: 128, baseline: 131 },
    journeys: { canary: [24, 24], baseline: [24, 24] },
  },
  {
    errorRate: { canary: 0.002, baseline: 0.0021 },
    p99Ms: { canary: 129, baseline: 130 },
    journeys: { canary: [24, 24], baseline: [24, 24] },
  },
];

const ERROR = 'delivery estimate failed: the basket has nothing to deliver';

/** The log watcher's lines from GET /basket on a version, each with its trace. */
function lines(version: string, times: string[]): Extract<Evidence, { kind: 'logs' }> {
  return {
    kind: 'logs',
    route: '/basket',
    version,
    requests: times.length,
    lines: times.map((ts, i) => ({
      ts,
      level: 'error',
      message: `GET /basket 200: ${ERROR}`,
      traceId: traceFor(`1306/${version}/${i}`),
    })),
  };
}

const SIGNAL = lines('v0.9.7', ['2026-10-05T08:02:41.208Z', '2026-10-05T08:03:17.954Z', '2026-10-05T08:04:52.031Z']);
const PERSISTS = lines('v0.9.8', ['2026-10-05T09:48:03.660Z', '2026-10-05T09:59:27.112Z']);
const AGAIN = lines('v0.9.12', ['2026-10-06T07:38:14.590Z', '2026-10-06T07:40:02.317Z']);

export default new Item('1306', '2026-10-05T09:05:00+01:00')
  .at('0:00', 'work-item.opened', 'triage', 'The log watcher opened a work item', {
    kind: 'defect-fix',
    title: 'Server errors on /basket',
    sample: true,
    category: 'errors',
  })
  .at('0:00', 'signal.received', 'logs', `GET /basket logged “${ERROR}” and still answered 200`, {
    sense: 'logs',
    check: 'new error pattern',
    route: '/basket',
    version: 'v0.9.7',
    symptom: 'server-error',
    evidence: [SIGNAL],
  })
  .at('0:00', 'ticket.opened', 'triage', 'Ticket #1306: errors, broken', {
    title: 'Server errors on /basket',
    category: 'errors',
    severity: 'broken',
    fingerprint: { route: '/basket', class: 'server-error' },
    traces: SIGNAL.lines.flatMap((line) => line.traceId ?? []),
  })
  .at('0:00', 'work-item.summarised', 'triage', 'Summary written', {
    title: 'Server errors on /basket',
    description: 'The basket logs an error each time it has nothing to deliver, though the page still answers.',
    story:
      'The log watcher saw a new error pattern on /basket: “delivery estimate failed”, three times in three minutes, each time from a page that still answered 200. A sense knows what it saw, so triage opened a ticket with the lines and their traces, without asking a model.',
  })
  .calls('planner', '0:30', '4:10', { calls: 3, input: 41_000, output: 2_900, cached: 0.3 })
  .at('4:20', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'An empty basket asks for no delivery estimate, and logs no error',
    criteria: [
      { given: 'an empty basket', when: 'the basket page is shown', expect: 'no error is logged' },
      {
        given: 'a basket with a ladder in it',
        when: 'the basket page is shown',
        expect: 'it gives a delivery estimate, as before',
      },
    ],
    scope: ['src/pages/basket.ts', 'test/basket.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '4:30', '14:40', { calls: 14, input: 380_000, output: 9_800, cached: 0.8 })
  .pushed('14:50', 'coder', 'A fix pushed to PR #1307', {
    number: 1307,
    title: 'fix(basket): ask for no delivery estimate for an empty basket',
    branch: 'factory/1306-basket-errors',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/basket.ts', added: 3, removed: 1 },
      { path: 'test/basket.test.ts', added: 16, removed: 0 },
    ],
  })
  .gates('15:00', { pullRequest: 1307, testsFirst: { failing: 1, of: 1 } })
  .calls('reviewer', '18:00', '20:00', { calls: 2, input: 48_000, output: 2_600, cached: 0.5 })
  .at('20:10', 'review.submitted', 'reviewer', 'Review of PR #1307: Approved', {
    pullRequest: 1307,
    verdict: 'approved',
    note: 'An empty basket no longer asks for an estimate, and the test reads the log as well as the page.',
    findings: [],
  })
  .calls('describer', '20:20', '21:40', { calls: 1, input: 22_000, output: 1_100, cached: 0.2 })
  .at('21:50', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'Server errors on /basket',
    description:
      'The basket logged an error whenever it had nothing to deliver. The fix asks for no estimate for an empty basket.',
    story:
      'The log watcher saw the basket log “delivery estimate failed” while still answering 200. The planner asked for an empty basket to ask for no estimate and to log nothing. The coder wrote a test that reads the log as well as the page, watched it fail, then made the change. Every check passed and the reviewer approved.',
  })
  .at('21:51', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1307 has passed its gates and review, and waits for Martin to merge it',
  })
  .at('1:15:00', 'pull-request.merged', 'martin', 'Martin merged PR #1307', {
    number: 1307,
    commit: commitFor('1306/merge'),
    by: 'martin',
  })
  .at('1:15:01', 'hold.started', 'factory', 'Waiting for a deploy pull request to carry the fix', {
    stage: 'release',
    kind: 'approval',
    cause: 'deploy',
    reason: 'The fix in pull request #1307 is merged, and waits for a deploy pull request to carry it to the shop',
  })
  .released('1:26:00', 'v0.9.8', 'v0.9.7', V098)
  // Thirty minutes after the promotion, the same error from the new version: a basket of gift cards has nothing to
  // deliver either, and the fix only looked for an empty one.
  .verify('2:02:30', 'Persists on v0.9.8, by the logs', {
    outcome: 'persists',
    sense: 'logs',
    actor: 'logs',
    check: 'new error pattern',
    against: 'v0.9.7',
    version: 'v0.9.8',
    evidence: PERSISTS,
    // The release carried #1304's fix to the contact form too: its page is #1304's own.
    theirs: { '/contact': '1304' },
  })
  .at('2:02:31', 'work.returned', 'factory', '#1306 · to Plan · sent back from verify', {
    from: 'verify',
    to: 'plan',
    reason: 'The logs still saw “new error pattern” on v0.9.8, the release that carried the fix',
  })
  .calls('planner', '2:03:00', '2:08:30', { calls: 3, input: 52_000, output: 3_200, cached: 0.4 })
  .at('2:09:00', 'spec.written', 'planner', 'Spec written: 3 criteria, 2 paths in scope', {
    outcome: 'A basket with nothing to deliver asks for no delivery estimate, and logs no error',
    criteria: [
      { given: 'an empty basket', when: 'the basket page is shown', expect: 'no error is logged' },
      {
        given: 'a basket holding only a gift card',
        when: 'the basket page is shown',
        expect: 'no error is logged, and no delivery is offered',
        from: 'The verification: the same error from v0.9.8, on baskets of gift cards',
      },
      {
        given: 'a basket with a ladder in it',
        when: 'the basket page is shown',
        expect: 'it gives a delivery estimate, as before',
      },
    ],
    scope: ['src/pages/basket.ts', 'test/basket.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:09:30', '2:39:00', { calls: 12, input: 330_000, output: 8_400, cached: 0.82 })
  .pushed('2:40:00', 'coder', 'A fix pushed to PR #1309', {
    number: 1309,
    title: 'fix(basket): ask for a delivery estimate only for what can be delivered',
    branch: 'factory/1306-basket-errors-2',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/basket.ts', added: 4, removed: 3 },
      { path: 'test/basket.test.ts', added: 14, removed: 0 },
    ],
  })
  .gates('2:40:10', { pullRequest: 1309, testsFirst: { failing: 1, of: 2 } })
  .calls('reviewer', '2:43:00', '2:51:00', { calls: 2, input: 51_000, output: 2_400, cached: 0.5 })
  .at('2:51:10', 'review.submitted', 'reviewer', 'Review of PR #1309: Approved', {
    pullRequest: 1309,
    verdict: 'approved',
    note: 'The estimate now follows what can be delivered, not whether the basket is empty, which covers both cases.',
    findings: [],
  })
  .calls('describer', '2:51:20', '2:53:00', { calls: 1, input: 24_000, output: 1_200, cached: 0.2 })
  .at('2:53:10', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'Server errors on /basket',
    description:
      'The basket logged an error whenever it had nothing to deliver. The first fix missed baskets of gift cards; the second asks for an estimate only for what can be delivered.',
    story:
      'The log watcher saw the basket log “delivery estimate failed” while still answering 200. The first fix, for an empty basket, went out in v0.9.8, and thirty minutes later Verify still saw the error from it: baskets holding only gift cards have nothing to deliver either. The work went back to Plan with the verification as evidence. The second spec named both cases, and the second fix asks for an estimate only for what can be delivered.',
  })
  .at('2:53:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1309 has passed its gates and review, and waits for Martin to merge it',
  })
  .at('3:05:00', 'pull-request.merged', 'martin', 'Martin merged PR #1309', {
    number: 1309,
    commit: commitFor('1306/merge/2'),
    by: 'martin',
  })
  .at('3:05:01', 'hold.started', 'factory', 'Waiting for a deploy pull request to carry the fix', {
    stage: 'release',
    kind: 'approval',
    cause: 'deploy',
    reason: 'The fix in pull request #1309 is merged, and waits for a deploy pull request to carry it to the shop',
  })
  .released('3:15:00', 'v0.9.10', 'v0.9.8', [
    {
      errorRate: { canary: 0.0019, baseline: 0.0021 },
      p99Ms: { canary: 127, baseline: 130 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
    {
      errorRate: { canary: 0.002, baseline: 0.002 },
      p99Ms: { canary: 128, baseline: 131 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  ])
  .verify('3:51:30', 'Cleared on v0.9.10, by the logs', {
    sense: 'logs',
    actor: 'logs',
    check: 'new error pattern',
    against: 'v0.9.8',
    version: 'v0.9.10',
    evidence: { kind: 'logs', route: '/basket', version: 'v0.9.10', requests: 312, lines: [] },
  })
  .at('3:51:31', 'work-item.closed', 'factory', 'Verified, and closed', {
    outcome: 'verified',
    reason: 'No error like the one the log watcher saw came from v0.9.10 in 30 minutes, over 312 requests',
  })
  // The next morning, a release of Martin's own (the line's, carrying no work item) logs the same error again.
  .at('23:36:00', 'work-item.reopened', 'triage', 'Reopened: the log watcher saw it again', {
    sense: 'logs',
    check: 'new error pattern',
    route: '/basket',
    version: 'v0.9.12',
    reason: 'The log watcher saw it again on /basket in version v0.9.12: new error pattern',
    dryRun: false,
  })
  .at('23:36:00', 'signal.received', 'logs', `GET /basket logged “${ERROR}” and still answered 200`, {
    sense: 'logs',
    check: 'new error pattern',
    route: '/basket',
    version: 'v0.9.12',
    symptom: 'server-error',
    evidence: [AGAIN],
  });
