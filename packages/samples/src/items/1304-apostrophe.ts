/**
 * A fix made overnight on the local model, at no cost, and merged by Martin in the morning. The reviewer approved it
 * with a suggestion, which went back to the coder for a round of its own; the coder declined it, saying why, so the
 * approval stood. It waits at Release for his deploy, and the release that carries it carries #1306's first fix too:
 * one release, on both work items.
 */
import { commitFor, Item } from '../build.ts';
import { V098 } from './1306-basket-errors.ts';

const LOCAL = { local: true };

export default new Item('1304', '2026-10-04T21:40:00+01:00')
  .probeTicket('0:00', {
    check: 'the contact form sends',
    route: '/contact',
    version: 'v0.9.7',
    symptom: 'server-error',
    summary: 'Contact journey: a message with an apostrophe answered 500, twice in a row',
    exchange: { method: 'POST', url: '/contact', status: 500, timings: { firstByteMs: 38, totalMs: 41 } },
    title: 'The contact form fails on an apostrophe',
    category: 'errors',
    severity: 'broken',
    description: 'Send the contact form a message with an apostrophe in it, and the shop answers with an error.',
    story:
      'The contact journey sent a message reading “I’d like a ladder”, and the shop answered 500, twice in a row. Triage opened a ticket from the probe’s own request, and the overnight run took it on the local model.',
  })
  .calls('planner', '0:10', '9:40', { calls: 4, input: 33_000, output: 3_100, cached: 0.3 }, LOCAL)
  .at('9:45', 'spec.written', 'planner', 'Spec written: 2 criteria, 2 paths in scope', {
    outcome: 'A message with an apostrophe is sent like any other',
    criteria: [
      {
        given: 'a message reading “I’d like a ladder”',
        when: 'the contact form sends it',
        expect: 'the shop thanks the visitor',
      },
      { given: 'a message with no apostrophe', when: 'the contact form sends it', expect: 'nothing has changed' },
    ],
    scope: ['src/pages/contact.ts', 'test/contact.test.ts'],
    risks: [],
    rollout: 'A normal release behind the canary.',
  })
  .calls('coder', '10:00', '1:22:30', { calls: 31, input: 470_000, output: 12_400, cached: 0.86 }, LOCAL)
  .pushed('1:22:40', 'coder', 'A fix pushed to PR #1305', {
    number: 1305,
    title: 'fix(contact): send a message with an apostrophe',
    branch: 'factory/1304-contact-apostrophe',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/contact.ts', added: 2, removed: 2 },
      { path: 'test/contact.test.ts', added: 18, removed: 0 },
    ],
  })
  .gates('1:23:00', { pullRequest: 1305, testsFirst: { failing: 1, of: 1 } })
  .calls('reviewer', '1:26:00', '1:41:30', { calls: 6, input: 80_000, output: 5_200, cached: 0.5 }, LOCAL)
  .at('1:41:40', 'review.submitted', 'reviewer', 'Review of PR #1305: Approved', {
    pullRequest: 1305,
    verdict: 'approved',
    note: 'The message is now passed as a value, not built into the query, and the test sends the apostrophe through the shop.',
    findings: [
      {
        path: 'test/contact.test.ts',
        line: 9,
        blocking: false,
        rule: 3,
        comment: 'Check the thank-you text the visitor reads, not only the status.',
      },
    ],
  })
  .at('1:41:41', 'work.returned', 'reviewer', '#1304 · round 2 · 1 suggestion', {
    from: 'review',
    to: 'build',
    reason: 'The review approved, with a suggestion to take or decline',
    round: 2,
    suggestions: 1,
  })
  .calls('coder', '1:42:00', '1:51:30', { calls: 4, input: 120_000, output: 1_200, cached: 0.9 }, LOCAL)
  .at('1:51:40', 'suggestions.answered', 'coder', 'The coder took 0 of 1 suggestions on PR #1305, and declined 1', {
    pullRequest: 1305,
    suggestions: 1,
    declined: [
      {
        suggestion: 1,
        reason:
          'The test checks the thank-you text already: on line 12 it reads “Thanks, we’ll be in touch” from the page the shop answers with.',
      },
    ],
  })
  .calls('describer', '1:52:00', '1:59:10', { calls: 2, input: 40_000, output: 3_000, cached: 0.2 }, LOCAL)
  .at('1:59:20', 'work-item.summarised', 'describer', 'Summary written', {
    title: 'The contact form fails on an apostrophe',
    description:
      'A message with an apostrophe in it made the contact form fail. Fixed overnight on the local model, at no cost, in one round.',
    story:
      'The contact journey found that a message with an apostrophe in it made the shop answer 500: the form built the message into its query. The overnight run took the ticket on the local model. The coder wrote a test that sends “I’d like a ladder” through the shop, then passed the message as a value. Every check passed, and the reviewer approved, suggesting the test check the thank-you text the visitor reads. The coder declined: the test reads it already.',
  })
  .at('1:59:21', 'hold.started', 'factory', 'Waiting for Martin to merge', {
    stage: 'review',
    kind: 'approval',
    cause: 'merge',
    reason: 'The fix in pull request #1305 has passed its gates and review, and waits for Martin to merge it',
  })
  .at('11:12:00', 'pull-request.merged', 'martin', 'Martin merged PR #1305', {
    number: 1305,
    commit: commitFor('1304/merge'),
    by: 'martin',
  })
  .at('11:12:01', 'hold.started', 'factory', 'Waiting for a deploy pull request to carry the fix', {
    stage: 'release',
    kind: 'approval',
    cause: 'deploy',
    reason: 'The fix in pull request #1305 is merged, and waits for a deploy pull request to carry it to the shop',
  })
  .released('12:51:00', 'v0.9.8', 'v0.9.7', V098)
  .verify('13:01:00', 'Cleared on v0.9.8, by the probe', {
    actor: 'probe',
    check: 'the contact form sends',
    against: 'v0.9.7',
    version: 'v0.9.8',
  })
  .at('13:01:01', 'work-item.closed', 'factory', 'Verified, and closed', {
    outcome: 'verified',
    reason: 'The probe’s check “the contact form sends” passed twice in a row on v0.9.8, which carries the fix',
  });
