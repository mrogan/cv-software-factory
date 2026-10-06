/** A defect a visitor injected, still on the line: sent back once by Gates, and now on the canary. */
import { commitFor, digestFor, Item, traceFor } from '../build.ts';
import { shot } from '../captures.ts';

const JOURNEY_FAILED = `✕ End-to-end journeys             required check · failed in 1m 52s
  search journey
    search for “ladder”          Ladder, one rung             ✓
    search for “sandpaper”       Please use a shorter word.   ✕ expected Sandpaper, smooth
  23 of 24 journeys passed`;

export default new Item('1302', '2026-10-03T10:12:00+01:00')
  .at('0:00', 'work-item.opened', 'visitor', 'A visitor chose “Search turns away long words” from the menu', {
    kind: 'injected-defect',
    title: 'Search turns away long words',
    sample: true,
    category: 'functional',
    visitor: { key: 'brisk-wren' },
  })
  .at(
    '3:20',
    'defect.injected',
    'injector',
    'The injected change went live as v0.9.6',
    { choice: 'Search turns away long words', version: 'v0.9.6', pullRequest: 1301 },
    [shot('published/search-fixed', 'v0.9.5')],
  )
  .at(
    '4:40',
    'signal.received',
    'probe',
    'A search for “ladder” was turned away: six letters is too long',
    { sense: 'probe', check: 'search journey', route: '/search', version: 'v0.9.6', symptom: 'rejects-valid-input' },
    [shot('short-words/search', 'v0.9.6')],
  )
  .at('5:06', 'ticket.opened', 'triage', 'Ticket #1302: functional, broken', {
    title: 'Search refuses any word longer than four letters',
    category: 'functional',
    severity: 'broken',
    fingerprint: { route: '/search', class: 'rejects-valid-input' },
    traces: [traceFor('1302/signal')],
  })
  .at('5:07', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Search turns away long words',
    description:
      'Search for anything longer than four letters and the shop asks for a shorter word. Triage has opened a ticket, and the planner is on it.',
    story:
      'A visitor chose “Search turns away long words”. It went live as v0.9.6, and the search journey noticed a minute and twenty seconds later: a search for a ladder was turned away.',
  })
  .calls('planner', '5:10', '5:55', { calls: 2, input: 27_000, output: 2_200, cached: 0.3 })
  .at('6:00', 'spec.written', 'planner', 'Spec: a search takes any word the box takes', {
    outcome: 'A search takes any word a visitor can type in the box, however long',
    criteria: [
      { given: 'a search for “ladder”', when: 'the results are shown', expect: 'the ladder is the first result' },
      { given: 'a search for “sandpaper”', when: 'the results are shown', expect: 'the sandpaper is found' },
      { given: 'a search that matches nothing', when: 'it answers', expect: 'it says so in the shop’s words' },
    ],
    scope: ['src/pages/search.ts', 'test/search.test.ts'],
    risks: [],
    rollout: 'Ships as a normal release behind the canary.',
  })
  .calls('coder', '6:05', '8:30', { calls: 11, input: 260_000, output: 6_100, cached: 0.85 })
  .pushed('8:40', 'coder', 'Failing test first, then the fix · PR #1303', {
    number: 1303,
    title: 'fix(search): take words of any length',
    branch: 'factory/1302-search',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/search.ts', added: 3, removed: 3 },
      { path: 'test/search.test.ts', added: 19, removed: 0 },
    ],
  })
  .gates('8:45', {
    pullRequest: 1303,
    failure: {
      check: 'End-to-end journeys',
      summary: 'a search for sandpaper was turned away',
      output: JOURNEY_FAILED,
    },
  })
  .at('11:43', 'work.returned', 'factory', 'Gates sent #1302 back · 1 check failed', {
    from: 'gates',
    to: 'build',
    reason: 'End-to-end journeys failed: a search for sandpaper was still turned away',
  })
  .calls('coder', '11:50', '13:10', { calls: 7, input: 180_000, output: 3_900, cached: 0.88 })
  .pushed('13:20', 'coder', 'Second attempt on PR #1303: the limit removed, not raised', {
    number: 1303,
    title: 'fix(search): take words of any length',
    branch: 'factory/1302-search',
    attempt: 2,
    testsFirst: true,
    files: [
      { path: 'src/pages/search.ts', added: 3, removed: 5 },
      { path: 'test/search.test.ts', added: 27, removed: 0 },
    ],
    whole: [
      { path: 'src/pages/search.ts', added: 3, removed: 5 },
      { path: 'test/search.test.ts', added: 27, removed: 0 },
    ],
  })
  .gates('13:25', { pullRequest: 1303, attempt: 2 })
  .calls('reviewer', '15:50', '16:20', { calls: 2, input: 35_000, output: 1_900, cached: 0.5 })
  .at('16:25', 'review.submitted', 'reviewer', 'Approved', {
    pullRequest: 1303,
    verdict: 'approved',
    note: 'The second attempt removes the limit instead of raising it, and tests a nine-letter word to prove it.',
    findings: [],
  })
  .at('16:30', 'pull-request.merged', 'factory', 'PR #1303 merged: low risk, so no one needed to approve it', {
    number: 1303,
    commit: commitFor('1302/merge'),
    by: 'factory',
  })
  .at('17:20', 'release.started', 'rollouts', 'v0.9.7 signed and admitted; canary at 25%', {
    version: 'v0.9.7',
    previous: 'v0.9.6',
    digest: digestFor('v0.9.7'),
    signed: true,
    admitted: true,
  })
  .at(
    '18:30',
    'canary.stepped',
    'rollouts',
    'Canary at 25%: every check passing',
    {
      version: 'v0.9.7',
      weight: 25,
      analysis: {
        errorRate: { canary: 0.002, baseline: 0.0022 },
        p99Ms: { canary: 131, baseline: 134 },
        journeys: { canary: [24, 24], baseline: [23, 24] },
      },
    },
    [shot('published/search', 'v0.9.7')],
  )
  .at('18:31', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Search turns away long words',
    description:
      'Search for anything longer than four letters and the shop asks for a shorter word. The fix is on the canary at 25%, and every check is passing.',
    story:
      'A visitor chose “Search turns away long words”. It went live as v0.9.6, and the search journey noticed within two minutes. The first fix raised the limit to eight letters instead of removing it: an end-to-end journey searched for sandpaper, was turned away, and Gates sent the change back to Build. The second attempt passed. It is on the canary now, as v0.9.7.',
  });
