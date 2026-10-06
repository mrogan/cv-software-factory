/**
 * Held at Review: the reviewer's blocking finding was still there after the second round, so the work waits for
 * Martin to merge it, close it, or send it back.
 */
import { Item } from '../build.ts';

const FINDING = {
  path: 'test/discount.test.ts',
  blocking: true,
  rule: 3,
} as const;

export default new Item('1323', '2026-10-06T13:40:00+01:00')
  .probeTicket('0:00', {
    check: 'a discount code applies',
    route: '/basket',
    version: 'v0.9.7',
    symptom: 'rejects-valid-input',
    summary: 'Basket journey: the code “ladders10” was refused; “LADDERS10” was taken',
    exchange: { method: 'POST', url: '/basket/discount', status: 400, timings: { firstByteMs: 10, totalMs: 12 } },
    title: 'Discount codes refuse lower case',
    category: 'functional',
    severity: 'degraded',
    description: 'Type a discount code in lower case, and the shop says it is not a code.',
    story:
      'The basket journey typed “ladders10” and the shop refused it, then took “LADDERS10”. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:20', '2:00', { calls: 3, input: 28_000, output: 1_800, cached: 0.3 })
  .at('2:10', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'A discount code is taken however it is typed',
    criteria: [
      { given: 'the code “ladders10”', when: 'it is applied', expect: 'the basket takes ten per cent off ladders' },
      { given: 'a code that does not exist', when: 'it is applied', expect: 'the shop says so, in its words' },
    ],
    scope: ['src/discounts.ts', 'test/discount.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:20', '7:30', { calls: 12, input: 200_000, output: 4_300, cached: 0.86 })
  .pushed('7:40', 'coder', 'A fix pushed to PR #1324', {
    number: 1324,
    title: 'fix(discounts): take a code in any case',
    branch: 'factory/1323-discount-codes',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/discounts.ts', added: 2, removed: 1 },
      { path: 'test/discount.test.ts', added: 14, removed: 0 },
    ],
  })
  .gates('7:50', { pullRequest: 1324, testsFirst: { failing: 1, of: 1 } })
  .calls('reviewer', '10:20', '12:10', { calls: 2, input: 30_000, output: 1_600, cached: 0.5 })
  .at('12:20', 'review.submitted', 'reviewer', 'Review of PR #1324: Changes requested: 1 blocking finding', {
    pullRequest: 1324,
    verdict: 'changes-requested',
    note: 'The fix is right, but its test calls the matcher directly instead of applying a code through the shop.',
    findings: [
      {
        ...FINDING,
        line: 14,
        comment:
          'The test calls matchCode() directly. Apply the code through the shop over HTTP, and check the basket a visitor sees.',
      },
    ],
  })
  .at('12:21', 'work.returned', 'reviewer', '#1323 · round 2 · 1 blocking', {
    from: 'review',
    to: 'build',
    reason: 'Review asked for changes: the test calls the matcher directly',
    round: 2,
    blocking: 1,
  })
  .calls('coder', '12:30', '16:40', { calls: 9, input: 160_000, output: 3_400, cached: 0.9 })
  .pushed('16:50', 'coder', 'Round 2 pushed to PR #1324', {
    number: 1324,
    title: 'fix(discounts): take a code in any case',
    branch: 'factory/1323-discount-codes',
    attempt: 2,
    testsFirst: true,
    files: [{ path: 'test/discount.test.ts', added: 6, removed: 1 }],
    whole: [
      { path: 'src/discounts.ts', added: 2, removed: 1 },
      { path: 'test/discount.test.ts', added: 19, removed: 3 },
    ],
  })
  .gates('17:00', { pullRequest: 1324, attempt: 2, testsFirst: { failing: 1, of: 1 } })
  .calls('reviewer', '19:30', '21:00', { calls: 2, input: 31_000, output: 1_500, cached: 0.5 })
  .at('21:10', 'review.submitted', 'reviewer', 'Review of PR #1324: Changes requested: 1 blocking finding', {
    pullRequest: 1324,
    verdict: 'changes-requested',
    note: 'The test now names the shop, but still calls the matcher directly instead of searching through the shop.',
    findings: [
      {
        ...FINDING,
        line: 16,
        comment: 'The test still calls matchCode() directly instead of applying the code through the shop.',
      },
    ],
  })
  .at('21:11', 'hold.started', 'factory', 'Held for Martin at review', {
    stage: 'review',
    kind: 'held',
    cause: 'review',
    reason:
      'Review asked for changes: the test now names the shop, but still calls the matcher directly instead of searching through the shop.',
  });
