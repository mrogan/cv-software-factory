/** A defect the metrics noticed: the home page was slow, and is now fast, and looks exactly the same. */
import { commitFor, digestFor, Item, traceFor } from '../build.ts';

const trace = traceFor('1288/slow');

/** p95 on the home page, every three minutes, from an hour before the signal until verification. */
const P95 = [
  631, 648, 640, 662, 637, 655, 622, 671, 644, 638, 651, 640, 633, 659, 642, 636, 647, 639, 604, 88, 86, 84, 85, 83, 86,
  85, 84, 87, 85,
];

export default new Item('1288', '2026-10-02T14:05:00+01:00')
  .at('0:00', 'work-item.opened', 'factory', 'The metrics opened a work item', {
    kind: 'defect-fix',
    title: 'The home page is slow',
    sample: true,
  })
  .at('0:01', 'signal.received', 'metrics', 'p95 on / at 640 ms against a 300 ms objective', {
    sense: 'metrics',
    check: 'objective: p95 under 300 ms on /',
    route: '/',
    version: 'v0.9.2',
    symptom: 'slow-response',
    evidence: [
      {
        kind: 'metric',
        name: 'p95 latency on /',
        unit: 'ms',
        objective: 300,
        start: '2026-10-02T12:05:00.000Z',
        stepSeconds: 300,
        values: [628, 655, 640, 661, 637, 648, 622, 670, 644, 638, 651, 640],
      },
    ],
  })
  .at('0:41', 'ticket.opened', 'triage', 'Ticket #1288 with a trace: 560 ms choosing the selection', {
    title: 'The home page is slow',
    category: 'performance',
    severity: 'degraded',
    fingerprint: { route: '/', class: 'slow-response' },
    traces: [trace],
  })
  .calls('planner', '0:50', '2:20', { calls: 3, input: 38_000, output: 3_100, cached: 0.3 })
  .at('2:30', 'spec.written', 'planner', 'Spec: p95 under 300 ms, and the page unchanged', {
    outcome: 'The home page answers within its objective, and looks exactly as it did',
    criteria: [
      { given: 'a warm cache', when: 'the home page is asked for', expect: 'its p95 is under 300 ms' },
      { given: 'the same week', when: 'the home page is shown twice', expect: 'it shows the same four products' },
      { given: 'any page', when: 'it is compared with v0.9.2', expect: 'not a pixel differs' },
    ],
    scope: ['src/pages/home.ts', 'src/shop.ts', 'test/home.test.ts'],
    risks: [],
    rollout: 'Ships as a normal release behind the canary.',
  })
  .calls('coder', '2:40', '9:10', { calls: 20, input: 520_000, output: 11_800, cached: 0.86 })
  .pushed('9:20', 'coder', 'Timing test first, then the selection kept for an hour · PR #1290', {
    number: 1290,
    title: 'perf(home): choose this week’s sundries once an hour',
    branch: 'factory/1288-home-page-speed',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/home.ts', added: 14, removed: 6 },
      { path: 'src/shop.ts', added: 22, removed: 2 },
      { path: 'test/home.test.ts', added: 36, removed: 0 },
    ],
  })
  .gates('9:30', { pullRequest: 1290 })
  .calls('reviewer', '12:00', '13:40', { calls: 2, input: 44_000, output: 2_600, cached: 0.5 })
  .at('13:50', 'review.submitted', 'reviewer', 'Changes requested: last week’s selection could outlast the week', {
    pullRequest: 1290,
    verdict: 'changes-requested',
    note: 'Kept for an hour from the first visit, last week’s sundries could still show at ten to one on a Monday morning. Keep the selection until the week turns instead.',
    findings: [
      {
        path: 'src/shop.ts',
        line: 41,
        blocking: true,
        criterion: 2,
        comment:
          'Kept for an hour from the first visit, last week’s sundries can still show early on a Monday. Keep the selection until the week turns.',
      },
    ],
  })
  .at('13:51', 'work.returned', 'reviewer', '#1288 · round 2 · 1 blocking', {
    from: 'review',
    to: 'build',
    reason: 'The reviewer asked for the selection to change when the week does, not an hour after the first visit',
    round: 2,
    blocking: 1,
  })
  .calls('coder', '14:00', '17:00', { calls: 8, input: 210_000, output: 4_600, cached: 0.88 })
  .pushed('17:10', 'coder', 'Second attempt on PR #1290: kept until the week turns', {
    number: 1290,
    title: 'perf(home): choose this week’s sundries once a week',
    branch: 'factory/1288-home-page-speed',
    attempt: 2,
    testsFirst: true,
    files: [
      { path: 'src/shop.ts', added: 5, removed: 2 },
      { path: 'test/home.test.ts', added: 12, removed: 0 },
    ],
    whole: [
      { path: 'src/pages/home.ts', added: 14, removed: 6 },
      { path: 'src/shop.ts', added: 25, removed: 2 },
      { path: 'test/home.test.ts', added: 48, removed: 0 },
    ],
  })
  .gates('17:15', { pullRequest: 1290, attempt: 2 })
  .calls('reviewer', '19:45', '20:20', { calls: 1, input: 23_000, output: 900, cached: 0.6 })
  .at('20:30', 'review.submitted', 'reviewer', 'Approved', {
    pullRequest: 1290,
    verdict: 'approved',
    note: 'The selection now turns at midnight on Monday; the test pins the clock either side of it.',
    findings: [],
  })
  .at('20:40', 'pull-request.merged', 'factory', 'PR #1290 merged: low risk, so no one needed to approve it', {
    number: 1290,
    commit: commitFor('1288/merge'),
    by: 'factory',
  })
  .at('22:00', 'release.started', 'rollouts', 'v0.9.3 signed and admitted; canary at 25%', {
    version: 'v0.9.3',
    previous: 'v0.9.2',
    digest: digestFor('v0.9.3'),
    signed: true,
    admitted: true,
  })
  .at('23:30', 'canary.stepped', 'rollouts', 'Canary at 25%: p99 92 ms against 702 ms on the baseline', {
    version: 'v0.9.3',
    weight: 25,
    analysis: {
      errorRate: { canary: 0.0018, baseline: 0.002 },
      p99Ms: { canary: 92, baseline: 702 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  })
  .at('25:20', 'release.promoted', 'rollouts', 'v0.9.3 promoted to 100%', { version: 'v0.9.3', previous: 'v0.9.2' })
  .verify('56:00', 'p95 on / under its objective for 30 minutes, and every page unchanged', {
    check: 'p95 under 300 ms on / for 30 minutes',
    against: 'v0.9.2',
    version: 'v0.9.3',
    evidence: {
      kind: 'metric',
      name: 'p95 latency on /',
      unit: 'ms',
      objective: 300,
      start: '2026-10-02T12:35:00.000Z',
      stepSeconds: 180,
      values: P95,
      marker: { index: 18, label: 'v0.9.3 canary' },
    },
  })
  .at('56:01', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'p95 is under the objective, and no page changed',
  })
  .at('56:02', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'The home page chose this week’s sundries on every visit',
    description:
      'The home page now chooses “This week’s sundries” once a week, not on every visit. p95 fell from 640 ms to 85 ms, and every page looks the same.',
    story:
      'The home page’s p95 latency had sat at 640 ms against a 300 ms objective. The trace showed most of it spent choosing “This week’s sundries”, which changes once a week but was worked out on every visit. The coder wrote a timing test first, then kept the selection for an hour. The reviewer sent that back: last week’s selection could outlast the week by most of an hour. The second attempt keeps it until the week turns. p95 is now 85 ms, and no page changed by a pixel.',
  });
