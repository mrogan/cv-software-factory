import { MAX_FINDINGS } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { type ReviewerInput, reviewer } from '../../src/line/agents/reviewer.ts';
import { FIXTURE_WORK_ITEM, FIXTURES } from '../../src/line/bench/fixtures.ts';
import { REVIEW_CHECK, reviewInGitHub, shownLines } from '../../src/line/review.ts';

const input: ReviewerInput =
  FIXTURES.reviewer['cards-claimed']?.input ??
  (() => {
    throw new Error('The reviewer has no cards-claimed fixture.');
  })();

const unmet = {
  path: 'src/money.ts',
  line: 3,
  blocking: true,
  criterion: 5,
  comment: 'The cards build their price themselves and never call pounds: criterion 5 is not met.',
};
const taste = { path: 'test/money.test.ts', line: 8, blocking: false, rule: 3, comment: 'Show it through a page.' };

describe('the reviewer', () => {
  it('is told the pull request, the spec, where the base is, and to read the rules as they are there', () => {
    const prompt = reviewer.prompt(input);
    expect(prompt).toContain(
      `Review pull request #102, the factory’s fix for ticket #${FIXTURE_WORK_ITEM}: “fix(money): pad pence to two digits in prices”.`,
    );
    expect(prompt).toContain('`git diff base` is the change');
    expect(prompt).toContain('Hold those claims to the diff, not the other way round.');
    expect(prompt).toContain(
      '5. Given a product that costs a whole number of pounds, when a visitor opens the product list, then its card shows the price with two zeros of pence, such as £2.00.',
    );
    expect(prompt).toContain('`git show base:docs/REVIEWERS.md`');
    expect(prompt).toContain('ask for nothing outside the ticket');
    // The gates have run the tests: the reviewer reads.
    expect(prompt).toContain('do not run them again, and do not start the app or send it requests');
    expect(prompt).not.toContain('in its round');
  });

  it('is told, in a later round, what the review before it blocked on', () => {
    const prompt = reviewer.prompt({ ...input, round: 2, blocked: [unmet] });
    expect(prompt).toContain('in its round 2');
    expect(prompt).toContain(`- src/money.ts:3 (criterion 5): ${unmet.comment}`);
  });

  it('hands back a verdict that agrees with its findings, each short, cited and anchored', () => {
    const schema = reviewer.schema(input);
    const fits = (result: unknown) => schema.safeParse(result).success;
    expect(fits({ verdict: 'escalated', note: 'The cards are outside the scope.', findings: [unmet, taste] })).toBe(
      true,
    );
    expect(fits({ verdict: 'changes-requested', note: 'The cards still drop a digit.', findings: [unmet] })).toBe(true);
    expect(fits({ verdict: 'approved', note: 'Fine, with a suggestion.', findings: [taste] })).toBe(true);
    for (const wrong of [
      { verdict: 'approved', note: 'Fine.', findings: [unmet] },
      { verdict: 'changes-requested', note: 'Hmm.', findings: [taste] },
      { verdict: 'changes-requested', note: 'Hmm.', findings: [{ ...unmet, comment: 'x'.repeat(301) }] },
      { verdict: 'changes-requested', note: 'Hmm.', findings: [{ ...unmet, criterion: 6 }] },
      { verdict: 'approved', note: '', findings: [] },
      { verdict: 'approved', note: 'Fine.', findings: [{ ...taste, body: 'old' }] },
      { verdict: 'approved', note: 'Fine.', findings: Array.from({ length: MAX_FINDINGS + 1 }, () => taste) },
    ]) {
      expect(fits(wrong), JSON.stringify(wrong).slice(0, 80)).toBe(false);
    }
  });

  it('is told the ticket and what the senses saw, and holds the spec to them as well as the change to the spec', () => {
    const widened = FIXTURES.reviewer['spec-widens']?.input;
    if (!widened) throw new Error('The reviewer has no spec-widens fixture.');
    const prompt = reviewer.prompt(widened);
    expect(prompt).toContain('The ticket: A wrong result on /products/:slug.');
    expect(prompt).toContain('It is a wrong-result on /products/:slug. Category functional, severity broken.');
    expect(prompt).toContain('1. A probe\'s check "a price is in pounds and two digits of pence" on /products/:slug');
    expect(prompt).toContain(
      '5. Given a price of 1234567 pence, when pounds is called with it, then it returns £12,345.67, with a comma between thousands. (From the ticket.)',
    );
    expect(prompt).toContain('2. Hold the spec to the ticket.');
    expect(prompt).toContain('is a blocking finding with `"ticket":true`');
  });

  it('sends a spec or a change beyond the ticket to Martin, never back to the coder', () => {
    const fits = (result: unknown) => reviewer.schema(input).safeParse(result).success;
    const beyond = { ...unmet, criterion: 5, ticket: true as const, comment: 'No evidence asks for the cards.' };
    expect(fits({ verdict: 'escalated', note: 'The spec goes beyond its ticket.', findings: [beyond] })).toBe(true);
    expect(fits({ verdict: 'changes-requested', note: 'Beyond the ticket.', findings: [beyond] })).toBe(false);
    expect(fits({ verdict: 'escalated', note: 'Beyond the ticket.', findings: [{ ...beyond, blocking: false }] })).toBe(
      false,
    );
  });
});

const DIFF = [
  {
    path: 'src/money.ts',
    patch: [
      '@@ -1,4 +1,4 @@',
      ' /** Prices are whole pence. */',
      ' export function pounds(pence: number): string {',
      '-  return `£${pence / 100}`;',
      '+  return `£${(pence / 100).toFixed(2)}`;',
      ' }',
    ].join('\n'),
    added: 1,
    removed: 1,
  },
  {
    path: 'test/money.test.ts',
    patch: "@@ -5,2 +5,3 @@\n   it.each([\n+    [600, '£6.00'],\n     [1250, '£12.50'],",
    added: 1,
    removed: 0,
  },
  { path: 'public/logo.png', patch: null, added: 0, removed: 0 },
];

describe('a review in GitHub', () => {
  it('knows the lines a diff shows in each file’s new version', () => {
    const shown = shownLines(DIFF);
    expect([...(shown.get('src/money.ts') ?? [])]).toEqual([1, 2, 3, 4]);
    expect([...(shown.get('test/money.test.ts') ?? [])]).toEqual([5, 6, 7]);
    expect(shown.get('public/logo.png')?.size).toBe(0);
  });

  it('anchors what the diff shows, lists the rest in its body, and reports a check run that is only a signal', () => {
    const review = {
      verdict: 'changes-requested' as const,
      note: 'The cards still drop a digit.',
      findings: [unmet, taste],
    };
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 1, last: false };
    const shown = reviewInGitHub(review, DIFF, at);
    expect(shown.comments).toEqual([
      { path: 'src/money.ts', line: 3, body: `**Blocking** · criterion 5\n\n${unmet.comment}` },
    ]);
    expect(shown.body).toContain('The cards still drop a digit.');
    expect(shown.body).toContain('- `test/money.test.ts:8`: **Suggestion** · rule 3: Show it through a page.');
    expect(shown.body).toContain('review 1. A signal, never a gate: the blocking findings go back to the coder.');
    expect(shown.check).toEqual({
      name: REVIEW_CHECK,
      headSha: 'c'.repeat(40),
      status: 'completed',
      conclusion: 'failure',
      title: 'Changes requested: 1 blocking finding',
      summary: expect.stringContaining(`- \`src/money.ts:3\`: **Blocking** · criterion 5: ${unmet.comment}`),
      externalId: '1001',
    });
    const approved = reviewInGitHub({ verdict: 'approved', note: 'Fine.', findings: [] }, DIFF, { ...at, review: 2 });
    expect(approved.check).toMatchObject({ conclusion: 'success', title: 'Approved', summary: 'Fine.' });
    expect(approved.body).not.toContain('Not on a line');
    expect(approved.body).toContain('review 2. A signal, never a gate: the change goes on to its description');
  });

  it('says where a review goes when the coder gets no more rounds: an escalation, or the last review', () => {
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 2, last: true };
    const blocking = { verdict: 'changes-requested' as const, note: 'Still wrong.', findings: [unmet] };
    expect(reviewInGitHub(blocking, DIFF, at).body).toContain('the last review the line allows, so Martin decides');
    const escalated = { ...blocking, verdict: 'escalated' as const };
    expect(reviewInGitHub(escalated, DIFF, { ...at, review: 1, last: false }).body).toContain(
      'it is escalated, and Martin decides',
    );
    expect(reviewInGitHub(escalated, DIFF, at).body).not.toContain('go back to the coder');
  });

  it('says when a finding cites the ticket', () => {
    const beyond = { ...unmet, ticket: true as const, comment: 'No evidence asks for the cards.' };
    const at = { commit: 'c'.repeat(40), workItem: '1001', review: 1, last: false };
    const shown = reviewInGitHub({ verdict: 'escalated', note: 'Beyond the ticket.', findings: [beyond] }, DIFF, at);
    expect(shown.comments[0]?.body).toBe(`**Blocking** · the ticket · criterion 5\n\n${beyond.comment}`);
  });
});
