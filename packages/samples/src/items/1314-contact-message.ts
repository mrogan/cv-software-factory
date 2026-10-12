/**
 * The canary in flight as the samples end: Martin merged the fix in the morning and his deploy in the afternoon, and
 * v0.9.13 has passed its 25% step and is being measured at 50%, against v0.9.12.
 */
import { commitFor, Item, started, stepped } from '../build.ts';

export default new Item('1314', '2026-10-06T09:00:00+01:00')
  .probeTicket('0:00', {
    check: 'the contact form keeps the message',
    route: '/contact',
    version: 'v0.9.12',
    symptom: 'wrong-result',
    summary: 'Contact journey: after a send the shop refused, the message box was empty, twice in a row',
    exchange: { method: 'POST', url: '/contact', status: 503, timings: { firstByteMs: 22, totalMs: 25 } },
    title: 'The contact form loses your message',
    category: 'functional',
    severity: 'broken',
    description: 'When sending the contact form fails, the message is gone, and the visitor has to type it again.',
    story:
      'The contact journey’s message was refused with a 503, as it is when the shop’s mail is busy, and the form came back with its message box empty, twice in a row. Triage opened a ticket from the probe’s own request.',
  })
  .calls('planner', '0:10', '1:50', { calls: 2, input: 36_000, output: 2_500, cached: 0.3 })
  .at('2:00', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'A message survives a send that fails',
    criteria: [
      {
        given: 'a message in the contact form',
        when: 'sending it fails',
        expect: 'the form still holds the message, with the shop’s apology above it',
      },
      { given: 'a message in the contact form', when: 'sending it works', expect: 'the shop thanks the visitor' },
    ],
    scope: ['src/pages/contact.ts', 'test/contact.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '2:10', '39:30', { calls: 19, input: 520_000, output: 11_800, cached: 0.84 })
  .pushed('40:00', 'coder', 'A fix pushed to PR #1316', {
    number: 1316,
    title: 'fix(contact): keep the message when sending fails',
    branch: 'factory/1314-contact-message',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/contact.ts', added: 9, removed: 3 },
      { path: 'test/contact.test.ts', added: 27, removed: 0 },
    ],
  })
  .gates('40:10', { pullRequest: 1316, testsFirst: { failing: 1, of: 2 } })
  .calls('reviewer', '44:00', '46:00', { calls: 2, input: 44_000, output: 2_300, cached: 0.5 })
  .at('46:10', 'review.submitted', 'reviewer', 'Review of PR #1316: Approved', {
    pullRequest: 1316,
    verdict: 'approved',
    note: 'The form is drawn again from what was sent, and the test makes the send fail through the shop.',
    findings: [],
  })
  .calls('describer', '46:20', '48:00', { calls: 1, input: 23_000, output: 1_200, cached: 0.2 })
  .at('48:10', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'The contact form loses your message',
    description:
      'A contact message was lost when sending it failed. The fix draws the form again with the message in it.',
    story:
      'The contact journey found that a message was cleared when sending it failed, so the visitor had to type it again. The planner asked for the message to survive a failed send. The coder wrote a test that makes the send fail through the shop, watched it fail, then drew the form again from what was sent. Every check passed and the reviewer approved.',
  })
  .at('48:11', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1316 has passed its gates and review, and waits for Martin to merge it',
  })
  .at('1:10:00', 'pull-request.merged', 'martin', 'Martin merged PR #1316', {
    number: 1316,
    commit: commitFor('1314/merge'),
    by: 'martin',
  })
  .at('1:10:01', 'hold.started', 'factory', 'Waiting for a deploy pull request to carry the fix', {
    stage: 'release',
    kind: 'approval',
    cause: 'deploy',
    reason: 'The fix in pull request #1316 is merged, and waits for a deploy pull request to carry it to the shop',
  })
  .at(
    '6:18:00',
    'release.started',
    'rollouts',
    'v0.9.13 signed and admitted; canary started',
    started('v0.9.13', 'v0.9.12'),
  )
  .at(
    '6:21:00',
    'canary.stepped',
    'rollouts',
    'Canary at 25%: the analysis passed',
    stepped('v0.9.13', 25, {
      errorRate: { canary: 0.0018, baseline: 0.0021 },
      p99Ms: { canary: 127, baseline: 130 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    }),
  );
