/**
 * An improvement turned off at Checks, and closed. Martin asked for a gift note in the basket; the planner named the
 * flag, `gift-note`, Martin approved the spec and the pull request, and it shipped in v0.9.7 beside #1302's fix, with
 * the flag off. Verify took its run with the flag off, and Martin widened it to Checks, where only the factory's own
 * checks see it. Verify's check there passed; its pictures are of the front page, the same off and on, as the change is
 * to the basket. He turned it off with his reason. The line closed the work item as turned off: its code stays in the
 * app, off, and nothing was rolled back.
 */
import { commitFor, Item } from '../build.ts';
import { shot } from '../captures.ts';
import { V097 } from './1302-long-words.ts';

/** The flag the spec names. */
const FLAG = 'gift-note';
const REASON = 'The note box covers the basket total on a phone';
/** The front page, which the probes picture while a spec names no pages. */
const HOME = shot('published/home', 'v0.9.7');

export default new Item('1299', '2026-10-03T09:30:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'A gift note in the basket',
    sample: true,
    category: 'improvement',
  })
  .calls('planner', '0:20', '3:00', { calls: 3, input: 34_000, output: 2_800, cached: 0.3 })
  .at('3:10', 'spec.written', 'planner', `Spec: three acceptance criteria, behind the ${FLAG} flag`, {
    outcome: `The basket takes a note to print with the order, behind the ${FLAG} flag`,
    criteria: [
      { given: 'the flag is on', when: 'the basket is shown', expect: 'it has a box for a gift note' },
      { given: 'a note of more than 200 characters', when: 'it is typed', expect: 'the rest is not taken' },
      { given: 'the flag is off', when: 'the basket is shown', expect: 'it is as before' },
    ],
    scope: ['src/pages/basket.ts', 'src/flags.ts', 'public/site.css', 'test/gift-note.test.ts'],
    risks: [],
    rollout: `Ships behind the ${FLAG} flag, off, which Martin widens a stage at a time.`,
    flag: FLAG,
  })
  .at('3:11', 'hold.started', 'factory', 'Waiting for Martin to approve the spec', {
    stage: 'plan',
    kind: 'approval',
    cause: 'spec',
    reason: 'An improvement is built only once Martin has approved its spec.',
  })
  .at('15:00', 'hold.answered', 'martin', 'Martin approved the spec', { decision: 'approved' })
  .calls('coder', '15:30', '28:00', { calls: 18, input: 410_000, output: 9_600, cached: 0.84 })
  .pushed('28:30', 'coder', 'Tests first, with the flag on and off · PR #1332', {
    number: 1332,
    title: 'feat(basket): take a gift note with the order',
    branch: 'factory/1299-gift-note',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/basket.ts', added: 18, removed: 1 },
      { path: 'src/flags.ts', added: 3, removed: 0 },
      { path: 'public/site.css', added: 9, removed: 0 },
      { path: 'test/gift-note.test.ts', added: 41, removed: 0 },
    ],
  })
  .gates('28:40', { pullRequest: 1332 })
  .calls('reviewer', '30:00', '33:00', { calls: 2, input: 38_000, output: 2_100, cached: 0.5 })
  .at('33:10', 'review.submitted', 'reviewer', 'Review of PR #1332: Approved', {
    pullRequest: 1332,
    verdict: 'approved',
    note: 'Each criterion has a test with the flag on, and the last with it off; the note is cut at 200 characters.',
    findings: [],
  })
  .at('33:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'An improvement’s pull request waits for Martin to merge it, whatever the autonomy level',
  })
  .at('50:00', 'pull-request.merged', 'martin', 'Martin merged PR #1332', {
    number: 1332,
    commit: commitFor('1299/merge'),
    by: 'martin',
  })
  // Out in v0.9.7 beside #1302's fix, with the flag off: nobody sees a change.
  .released('59:20', 'v0.9.7', 'v0.9.6', V097, { promotion: `v0.9.7 promoted to 100%, the ${FLAG} flag off` })
  .at(
    '1:06:00',
    'flag.checked',
    'factory',
    `${FLAG} with the flag off, on v0.9.7: 24 of 24 checks passed`,
    {
      stage: 'off',
      flag: FLAG,
      version: 'v0.9.7',
      revision: 'r5',
      journeys: { passed: 24, ran: 24 },
      notClean: [],
      pages: [{ page: '/', route: '/', off: HOME.hash }],
    },
    [HOME],
  )
  .at('4:30:00', 'flag.staged', 'martin', `Martin widened ${FLAG} from Off to Checks`, {
    flag: FLAG,
    from: { stage: 'off' },
    to: { stage: 'checks' },
    action: 'flag.to-checks',
    revision: 'r7',
    steppedUp: false,
  })
  .at(
    '4:36:00',
    'flag.checked',
    'factory',
    `${FLAG} at Checks: passed`,
    {
      stage: 'checks',
      flag: FLAG,
      version: 'v0.9.7',
      revision: 'r7',
      moveRevision: 'r7',
      against: 'v0.9.7',
      outcome: 'passed',
      journeys: { base: { passed: 24, ran: 24 }, change: { passed: 24, ran: 24 } },
      regressions: [],
      pages: [{ page: '/', route: '/', off: HOME.hash, on: HOME.hash, changed: 0 }],
    },
    [HOME],
  )
  .at('4:30:01', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'A gift note in the basket',
    description: 'The basket takes a note to print with the order, behind its flag. It shipped off, and is at Checks.',
    story:
      'Martin asked for the basket to take a gift note to print with the order. The planner wrote a spec naming its flag, gift-note, the one page it changes and three acceptance criteria, proved by the pull request’s own tests with the flag on and off. Martin approved the spec and the pull request, and it shipped in v0.9.7 with the flag off.',
  })
  .at('5:40:00', 'flag.staged', 'martin', `Martin turned ${FLAG} off, from Checks`, {
    flag: FLAG,
    from: { stage: 'checks' },
    to: { stage: 'off' },
    action: 'flag.off',
    revision: 'r8',
    reason: REASON,
    steppedUp: false,
  })
  .at('5:40:30', 'work-item.closed', 'factory', `Closed: Martin turned ${FLAG} off, from Checks`, {
    outcome: 'turned-off',
    reason: REASON,
  });
