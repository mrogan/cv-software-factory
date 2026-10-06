/**
 * Held at Gates by the tests-first check: every required check passed, but the change's new tests pass on the base
 * as well, so they prove nothing about the fix.
 */
import { commitFor, Item } from '../build.ts';

const TESTS_PASS = `tests first · run on the base, ${commitFor('1317/base').slice(0, 7)}
  ✓ passes  delivery › a Friday order arrives on Monday
  ✓ passes  delivery › a Saturday order arrives on Tuesday
0 of 2 new tests fail before the fix`;

export default new Item('1317', '2026-10-06T10:20:00+01:00')
  .probeTicket('0:00', {
    check: 'delivery dates are working days',
    route: '/delivery',
    version: 'v0.9.7',
    symptom: 'wrong-result',
    summary: 'Delivery journey: an order on Friday is promised for Sunday',
    exchange: { method: 'GET', url: '/delivery?ordered=friday', status: 200, timings: { firstByteMs: 9, totalMs: 15 } },
    title: 'Delivery is promised on a Sunday',
    category: 'functional',
    severity: 'degraded',
    description: 'Order on a Friday, and the shop promises delivery on Sunday, when nothing is delivered.',
    story:
      'The delivery journey ordered on a Friday and was promised Sunday. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:20', '2:20', { calls: 3, input: 30_000, output: 2_100, cached: 0.3 })
  .at('2:30', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'Delivery is only ever promised on a working day',
    criteria: [
      { given: 'an order on a Friday', when: 'the delivery date is shown', expect: 'it is the Monday after' },
      { given: 'an order on a Saturday', when: 'the delivery date is shown', expect: 'it is the Tuesday after' },
    ],
    scope: ['src/delivery.ts', 'test/delivery.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:40', '9:10', { calls: 15, input: 240_000, output: 5_200, cached: 0.86 })
  .pushed('9:20', 'coder', 'A fix pushed to PR #1318', {
    number: 1318,
    title: 'fix(delivery): promise only working days',
    branch: 'factory/1317-delivery-dates',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/delivery.ts', added: 7, removed: 2 },
      { path: 'test/delivery.test.ts', added: 16, removed: 0 },
    ],
  })
  .gates('9:30', { pullRequest: 1318, testsFirst: { failing: 0, of: 2, output: TESTS_PASS } })
  .at('12:00', 'hold.started', 'factory', 'Held for Martin at gates', {
    stage: 'gates',
    kind: 'held',
    cause: 'tests-first',
    reason: 'The change’s new tests pass on the base, without the fix: they prove nothing about it',
  });
