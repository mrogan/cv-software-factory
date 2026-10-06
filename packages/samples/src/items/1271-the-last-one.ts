/** An improvement Martin asked for: specified, approved, built behind a flag and verified in production. */
import { commitFor, digestFor, Item } from '../build.ts';
import { shot } from '../captures.ts';

export default new Item('1271', '2026-10-01T10:05:00+01:00')
  .at('0:00', 'work-item.opened', 'martin', 'Martin asked for an improvement from the console', {
    kind: 'improvement',
    title: 'Say when it is the last one',
    sample: true,
    category: 'improvement',
  })
  .calls('planner', '0:20', '3:00', { calls: 3, input: 41_000, output: 3_300, cached: 0.3 })
  .at(
    '3:10',
    'spec.written',
    'planner',
    'Spec: three acceptance criteria, behind the last-one flag',
    {
      outcome: 'A product with one left says so on its card, behind the last-one flag',
      criteria: [
        {
          given: 'a product with one in stock',
          when: 'its card is shown',
          expect: 'it says “The last one” under the price',
        },
        { given: 'a product with more than one', when: 'its card is shown', expect: 'the card is as before' },
        { given: 'the flag is off', when: 'any card is shown', expect: 'every card is as before' },
      ],
      scope: ['src/pages/cards.ts', 'src/flags.ts', 'public/site.css', 'test/cards.test.ts'],
      risks: [],
      rollout: 'Ships behind the last-one flag, which goes on once the canary passes.',
      flag: 'last-one',
    },
    [shot('published/products', 'v0.8.5')],
  )
  .at('3:11', 'hold.started', 'factory', 'Waiting for Martin to approve the spec', {
    stage: 'plan',
    kind: 'approval',
    cause: 'spec',
    reason: 'An improvement is built only once Martin has approved its spec.',
  })
  .at('5:00', 'hold.answered', 'martin', 'Martin approved the spec', { decision: 'approved' })
  .calls('coder', '5:10', '14:20', { calls: 22, input: 610_000, output: 13_500, cached: 0.87 })
  .at('14:30', 'pull-request.pushed', 'coder', 'Tests first, then the change · PR #1273', {
    number: 1273,
    title: 'feat(cards): say when it is the last one',
    branch: 'factory/1271-the-last-one',
    attempt: 1,
    testsFirst: true,
    files: [
      { path: 'src/pages/cards.ts', added: 6, removed: 1 },
      { path: 'src/flags.ts', added: 9, removed: 0 },
      { path: 'public/site.css', added: 9, removed: 0 },
      { path: 'test/cards.test.ts', added: 44, removed: 0 },
    ],
  })
  .gates('14:40', { pullRequest: 1273 })
  .calls('reviewer', '17:10', '19:30', { calls: 2, input: 46_000, output: 2_600, cached: 0.5 })
  .at('19:40', 'review.submitted', 'reviewer', 'Approved, with one suggestion taken', {
    pullRequest: 1273,
    verdict: 'approved',
    note: 'Suggested the tag be words as well as colour, so it reads without the green; the coder made it so.',
    findings: [
      {
        path: 'src/pages/cards.ts',
        line: 18,
        blocking: false,
        criterion: 1,
        comment: 'Say it in words as well as colour, so the tag reads without the green.',
      },
    ],
  })
  .at('19:50', 'pull-request.merged', 'factory', 'PR #1273 merged: low risk, so no one needed to approve it', {
    number: 1273,
    commit: commitFor('1271/merge'),
    by: 'factory',
  })
  .at('20:30', 'release.started', 'rollouts', 'v0.9.0 signed and admitted; canary at 25%', {
    version: 'v0.9.0',
    previous: 'v0.8.5',
    digest: digestFor('v0.9.0'),
    signed: true,
    admitted: true,
  })
  .at('22:00', 'canary.stepped', 'rollouts', 'Canary at 25%: every check passing', {
    version: 'v0.9.0',
    weight: 25,
    analysis: {
      errorRate: { canary: 0.002, baseline: 0.0021 },
      p99Ms: { canary: 130, baseline: 132 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  })
  .at('24:05', 'release.promoted', 'rollouts', 'v0.9.0 promoted to 100%, and the last-one flag switched on', {
    version: 'v0.9.0',
    previous: 'v0.8.5',
  })
  .verify('31:20', 'The acceptance criteria pass in production', {
    check: 'Acceptance criteria, in production',
    against: 'v0.8.5',
    version: 'v0.9.0',
    variant: 'last-one',
    marked: shot('last-one/products-marked', 'v0.9.0'),
  })
  .at('31:21', 'work-item.closed', 'factory', 'Closed: verified', {
    outcome: 'verified',
    reason: 'The acceptance criteria pass in production',
  })
  .at('31:22', 'work-item.summarised', 'factory', 'Summary written', {
    title: 'Say when it is the last one',
    description:
      'A product with one left now says “The last one” on its card. It shipped behind a flag, switched on once the canary passed.',
    story:
      'Martin asked for products with one left to say so on their cards, so nobody has to open a product to find it is the last. The planner wrote a spec with three acceptance criteria, and Martin approved it. The coder wrote the tests first, then the change, behind the last-one flag. Every check passed, the reviewer’s one suggestion was taken, and v0.9.0 went out behind a canary. Once it was on all traffic the flag went on, and the acceptance criteria passed in production. Only the pages that list products changed.',
  });
