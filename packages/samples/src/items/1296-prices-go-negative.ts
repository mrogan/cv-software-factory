/** A defect a visitor injected from the menu: noticed in four minutes, fixed and verified in sixteen. */
import { commitFor, digestFor, Item, traceFor } from '../build.ts';
import { shot } from '../captures.ts';

export default new Item('1296', '2026-10-03T09:02:00+01:00')
  .at('0:00', 'work-item.opened', 'visitor', 'A visitor chose “Prices go negative” from the menu', {
    kind: 'injected-defect',
    title: 'Prices go negative',
    sample: true,
    category: 'functional',
    visitor: { key: 'amber-otter' },
  })
  .at(
    '3:10',
    'defect.injected',
    'injector',
    'The injected change went live as v0.9.4',
    { choice: 'Prices go negative', version: 'v0.9.4', pullRequest: 1297 },
    [shot('published/home-sundries', 'v0.9.3')],
  )
  .at(
    '4:20',
    'signal.received',
    'probe',
    'The home journey saw a price of £-6.00',
    { sense: 'probe', check: 'home journey', route: '/', version: 'v0.9.4', symptom: 'wrong-result' },
    [shot('negative/home-sundries', 'v0.9.4')],
  )
  .at('4:51', 'ticket.opened', 'triage', 'Ticket #1296: functional, broken', {
    title: 'Prices below zero on the home page',
    category: 'functional',
    severity: 'broken',
    fingerprint: { route: '/', class: 'wrong-result' },
    traces: [traceFor('1296/signal')],
  })
  .calls('planner', '4:55', '5:35', { calls: 2, input: 29_000, output: 2_400, cached: 0.3 })
  .at('5:40', 'spec.written', 'planner', 'Spec: a price can never be negative', {
    outcome: 'Every price on every page is the product’s price, above zero, to the penny',
    criteria: [
      { given: 'any product', when: 'its card is shown', expect: 'its price is above zero' },
      { given: 'a stored price of 600 pence', when: 'it is shown', expect: 'it reads £6.00' },
      { given: 'a negative stored price', when: 'a page would show it', expect: 'the page refuses and logs an error' },
    ],
    scope: ['src/pages/cards.ts', 'src/money.ts', 'test/cards.test.ts', 'test/money.test.ts'],
    risks: [],
    rollout: 'Ships as a normal release behind the canary.',
  })
  .calls('coder', '5:45', '8:05', { calls: 14, input: 330_000, output: 7_900, cached: 0.85 })
  .pushed('8:15', 'coder', 'Failing test first, then the fix · PR #1298', {
    number: 1298,
    title: 'fix(cards): show each price as it is stored',
    branch: 'factory/1296-prices',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/cards.ts', added: 1, removed: 1 },
      { path: 'src/money.ts', added: 6, removed: 0 },
      { path: 'test/cards.test.ts', added: 18, removed: 0 },
      { path: 'test/money.test.ts', added: 12, removed: 0 },
    ],
  })
  .gates('8:20', { pullRequest: 1298 })
  .calls('reviewer', '10:40', '11:50', { calls: 2, input: 33_000, output: 1_800, cached: 0.5 })
  .at('12:00', 'review.submitted', 'reviewer', 'Approved', {
    pullRequest: 1298,
    verdict: 'approved',
    note: 'Fixes the sign at its source and guards against it ever reaching a page again.',
    findings: [],
  })
  .at('12:05', 'pull-request.merged', 'factory', 'PR #1298 merged: low risk, so no one needed to approve it', {
    number: 1298,
    commit: commitFor('1296/merge'),
    by: 'factory',
  })
  .at('12:40', 'release.started', 'rollouts', 'v0.9.5 signed and admitted; canary at 25%', {
    version: 'v0.9.5',
    previous: 'v0.9.4',
    digest: digestFor('v0.9.5'),
    signed: true,
    admitted: true,
  })
  .at(
    '13:30',
    'canary.stepped',
    'rollouts',
    'Canary at 25%: every price above zero on the canary',
    {
      version: 'v0.9.5',
      weight: 25,
      analysis: {
        errorRate: { canary: 0.0019, baseline: 0.0021 },
        p99Ms: { canary: 129, baseline: 131 },
        journeys: { canary: [24, 24], baseline: [23, 24] },
      },
    },
    [shot('published/home-sundries', 'v0.9.5')],
  )
  .at('13:40', 'release.promoted', 'rollouts', 'v0.9.5 promoted to 100%', { version: 'v0.9.5', previous: 'v0.9.4' })
  .verify('16:05', 'Every price above zero on every page; every page matches v0.9.3, before the injection', {
    check: 'Every price above zero, on every page',
    against: 'v0.9.3',
    version: 'v0.9.5',
    marked: shot('published/home-fixed', 'v0.9.5'),
  })
  .at('16:06', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'Every price is above zero, and every page matches the version before the injection',
  })
  .at('16:07', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Prices go negative',
    description:
      'Injected from the menu at 09:02. A probe saw £-6.00 four minutes later; the fix was live and verified sixteen minutes after injection.',
    story:
      'A visitor chose “Prices go negative” from the Inject a defect menu. The injector sent the change through the normal pipeline, and it went live as v0.9.4. A minute later the home journey saw the stopped clock priced at £-6.00 in this week’s sundries. Triage opened a ticket with the screenshot, the planner wrote a spec, and the coder wrote a failing test before the fix. The fix went out as v0.9.5, and sixteen minutes after the injection every page matched the version before it.',
  });
