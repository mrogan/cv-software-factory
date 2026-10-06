/**
 * A fix through two rounds of review, waiting for Martin's merge: the reviewer's blocking findings, each citing the
 * app's rules, went back to the coder, whose second attempt the reviewer approved, and the describer wrote it up.
 */
import { Item } from '../build.ts';

export default new Item('1311', '2026-10-05T16:01:00+01:00')
  .probeTicket('0:00', {
    check: 'the basket takes a quantity',
    route: '/basket',
    version: 'v0.9.7',
    symptom: 'rejects-valid-input',
    summary: 'Basket journey: a quantity of 12 was refused, twice in a row',
    exchange: { method: 'POST', url: '/basket', status: 400, timings: { firstByteMs: 11, totalMs: 13 } },
    title: 'Quantities over nine are refused',
    category: 'functional',
    severity: 'broken',
    description: 'Ask the basket for ten or more of anything, and the shop refuses: it takes one digit only.',
    story:
      'The basket journey asked for twelve clothes pegs, and the shop answered 400, twice in a row. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:20', '2:10', { calls: 3, input: 46_000, output: 3_000, cached: 0.3 })
  .at('2:20', 'spec.written', 'planner', 'Spec written: 2 criteria, 3 paths in scope', {
    outcome: 'The basket takes any quantity a visitor can type, up to the stock there is',
    criteria: [
      { given: 'a basket with clothes pegs in it', when: 'the quantity is set to 12', expect: 'the basket holds 12' },
      {
        given: 'more than the shop has in stock',
        when: 'the quantity is set',
        expect: 'it says how many there are, in the shop’s words',
      },
    ],
    scope: ['src/pages/basket.ts', 'test/basket.test.ts', 'test/support/shop.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:30', '9:40', { calls: 17, input: 640_000, output: 16_000, cached: 0.78 })
  .pushed('9:50', 'coder', 'A fix pushed to PR #1312', {
    number: 1312,
    title: 'fix(basket): take quantities of any length',
    branch: 'factory/1311-basket-quantities',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/basket.ts', added: 4, removed: 3 },
      { path: 'test/basket.test.ts', added: 18, removed: 0 },
    ],
  })
  .gates('10:00', { pullRequest: 1312, testsFirst: { failing: 2, of: 2 } })
  .calls('reviewer', '12:30', '14:50', { calls: 3, input: 70_000, output: 4_000, cached: 0.5 })
  .at('15:00', 'review.submitted', 'reviewer', 'Review of PR #1312: Changes requested: 2 blocking findings', {
    pullRequest: 1312,
    verdict: 'changes-requested',
    note: 'The fix is right; the test and the page reach past the shop’s seams. Two things to change before this merges.',
    findings: [
      {
        path: 'test/basket.test.ts',
        line: 14,
        blocking: true,
        rule: 3,
        comment:
          'The test calls parseQuantity() directly. Set the quantity through the shop over HTTP, so the test checks what a visitor sees.',
      },
      {
        path: 'src/pages/basket.ts',
        line: 8,
        blocking: true,
        rule: 2,
        comment: 'The page opens a catalogue of its own to check the stock. Take the one createShop passes in.',
      },
      {
        path: 'src/pages/basket.ts',
        line: 31,
        blocking: false,
        rule: 1,
        comment: 'The “not enough in stock” sentence is built in two places; one would do.',
      },
    ],
  })
  .at('15:01', 'work.returned', 'reviewer', '#1311 · round 2 · 2 blocking', {
    from: 'review',
    to: 'build',
    reason: 'Review asked for changes: the test and the page reach past the shop’s seams',
    round: 2,
    blocking: 2,
  })
  .calls('coder', '15:10', '22:20', { calls: 12, input: 460_000, output: 11_500, cached: 0.8 })
  .pushed('22:30', 'coder', 'Round 2 pushed to PR #1312', {
    number: 1312,
    title: 'fix(basket): take quantities of any length',
    branch: 'factory/1311-basket-quantities',
    attempt: 2,
    testsFirst: true,
    files: [
      { path: 'src/pages/basket.ts', added: 3, removed: 4 },
      { path: 'test/basket.test.ts', added: 14, removed: 5 },
    ],
    whole: [
      { path: 'src/pages/basket.ts', added: 3, removed: 5 },
      { path: 'test/basket.test.ts', added: 27, removed: 0 },
    ],
  })
  .gates('22:40', { pullRequest: 1312, attempt: 2, testsFirst: { failing: 3, of: 3 } })
  .calls('reviewer', '25:20', '27:10', { calls: 2, input: 60_000, output: 3_000, cached: 0.5 })
  .at('27:20', 'review.submitted', 'reviewer', 'Review of PR #1312: Approved', {
    pullRequest: 1312,
    verdict: 'approved',
    note: 'Both blocking findings are answered: the test sets twelve through the shop over HTTP, and the page takes its catalogue.',
    findings: [
      {
        path: 'src/pages/basket.ts',
        line: 29,
        blocking: false,
        rule: 1,
        comment: 'The “not enough in stock” sentence is still built in two places.',
      },
    ],
  })
  .calls('describer', '27:30', '29:50', { calls: 2, input: 24_000, output: 1_300, cached: 0.2 })
  .at('30:00', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'Quantities over nine are refused',
    description:
      'The basket takes any quantity, and a test sets twelve through the shop. It passed its gates and review in two rounds, and waits for Martin to merge it.',
    story:
      'The basket journey found that the shop refused a quantity of twelve: it took one digit only. The planner asked for any quantity up to the stock there is. The coder’s first attempt passed every gate, but the reviewer sent it back twice over: its test reached inside the basket page, and the page opened its own catalogue. The second attempt sets the quantity through the shop over HTTP, and the reviewer approved it, with one suggestion.',
  })
  .at('30:01', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1312 has passed its gates and review, and waits for Martin to merge it',
  });
