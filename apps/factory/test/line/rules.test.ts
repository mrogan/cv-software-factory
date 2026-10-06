import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { countRules, rulesIn, rulesTable } from '../../src/line/rules.ts';

const REVIEWERS = `# Reviewing

Rules for reviewing a change to this repository.

1. **Deep modules.** A module hides a decision behind a small interface.
2. **Collaborators come in.** A module is given its database.
3. **Test at the seams.** Tests go through the shop over HTTP.
4. **One form inside.** Money is whole pence until a page shows it.
`;

type Finding = PayloadOf<'review.submitted'>['findings'][number];
const at = (rule: number | undefined, blocking = false, criterion?: number): Finding => ({
  path: 'src/money.ts',
  line: 3,
  blocking,
  ...(rule ? { rule } : {}),
  ...(criterion ? { criterion } : {}),
  comment: 'A finding.',
});
const review = (...findings: Finding[]): PayloadOf<'review.submitted'> => ({
  pullRequest: 12,
  verdict: findings.some((f) => f.blocking) ? 'changes-requested' : 'approved',
  note: 'A review.',
  findings,
});

describe('the rules, counted', () => {
  it('reads the numbered rules from docs/REVIEWERS.md', () => {
    expect(rulesIn(REVIEWERS)).toEqual([
      { number: 1, title: 'Deep modules' },
      { number: 2, title: 'Collaborators come in' },
      { number: 3, title: 'Test at the seams' },
      { number: 4, title: 'One form inside' },
    ]);
  });

  it('counts findings by rule, says which were never cited and which are cited often, and counts the rest', () => {
    const reviews = [
      review(at(3, true), at(3), at(undefined, true, 2)),
      review(at(3)),
      review(at(4, true)),
      review(),
      review(at(undefined)),
    ];
    const counts = countRules(reviews, rulesIn(REVIEWERS));
    expect(counts).toMatchObject({ reviews: 5, findings: 6, criteria: 1, uncited: 1 });
    expect(counts.rules).toEqual([
      { number: 1, title: 'Deep modules', cited: 0, blocking: 0, suggests: 'could-go' },
      { number: 2, title: 'Collaborators come in', cited: 0, blocking: 0, suggests: 'could-go' },
      // In two reviews of five.
      { number: 3, title: 'Test at the seams', cited: 3, blocking: 1, suggests: 'cited-often' },
      { number: 4, title: 'One form inside', cited: 1, blocking: 1, suggests: undefined },
    ]);
    const table = rulesTable(counts);
    expect(table).toContain('6 findings in 5 reviews.');
    expect(table).toMatch(/^1 +0 +0 +Deep modules +never cited: could it go\?$/m);
    expect(table).toMatch(/^3 +3 +1 +Test at the seams +cited often: a lint rule, or an invariant for AGENTS\.md\?$/m);
  });

  it('counts only the rules cited, untitled, without docs/REVIEWERS.md, and calls nothing often from a few reviews', () => {
    const counts = countRules([review(at(5)), review(at(5))]);
    expect(counts.rules).toEqual([{ number: 5, title: '', cited: 2, blocking: 0, suggests: undefined }]);
  });
});
