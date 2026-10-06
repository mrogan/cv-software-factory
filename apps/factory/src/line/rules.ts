/**
 * How often the reviewer cites each rule of the app's `docs/REVIEWERS.md`, from the reviews in the event store. The
 * rules are Martin's, and the count is what he keeps them by: a rule never cited can go; one cited often is a
 * candidate for a lint rule, which the gates would then check, or for `AGENTS.md`, if it is an invariant the coder
 * should hold to from the start.
 */
import type { PayloadOf } from '@software-factory/events';

/** A rule as `docs/REVIEWERS.md` numbers it: "1. **Deep modules.** A module hides…". */
export interface Rule {
  number: number;
  title: string;
}

export interface RuleCount extends Rule {
  /** Findings that cite it, and of those, how many blocked. */
  cited: number;
  blocking: number;
  /** What the count suggests: nothing, that it could go, or that it could be checked or held earlier. */
  suggests: 'could-go' | 'cited-often' | undefined;
}

export interface RuleCounts {
  reviews: number;
  findings: number;
  rules: RuleCount[];
  /** Findings that cite a criterion of the spec and no rule, and those that cite neither. */
  criteria: number;
  uncited: number;
}

/** Cited in this share of reviews or more, a rule is cited often. */
const OFTEN = 0.25;

/** The numbered rules in a `docs/REVIEWERS.md`, with the bold title each starts with. */
export function rulesIn(markdown: string): Rule[] {
  return [...markdown.matchAll(/^(\d+)\.\s+\*\*(.+?)\*\*/gm)].map(([, number, title]) => ({
    number: Number(number),
    title: (title ?? '').replace(/\.$/, ''),
  }));
}

/**
 * Counts each rule's findings. With the rules from `docs/REVIEWERS.md`, every rule is counted, those never cited
 * among them; without, only the rules some finding cites, untitled.
 */
export function countRules(reviews: readonly PayloadOf<'review.submitted'>[], rules?: readonly Rule[]): RuleCounts {
  const findings = reviews.flatMap((r) => r.findings);
  const known = new Map((rules ?? []).map((r) => [r.number, r.title]));
  for (const f of findings) if (f.rule !== undefined && !known.has(f.rule)) known.set(f.rule, '');
  const counted = [...known]
    .sort(([a], [b]) => a - b)
    .map(([number, title]): RuleCount => {
      const citing = findings.filter((f) => f.rule === number);
      // In how many reviews, not how many findings: one review that cites a rule five times is one review.
      const inReviews = reviews.filter((r) => r.findings.some((f) => f.rule === number)).length;
      return {
        number,
        title,
        cited: citing.length,
        blocking: citing.filter((f) => f.blocking).length,
        suggests:
          citing.length === 0
            ? 'could-go'
            : reviews.length >= 4 && inReviews / reviews.length >= OFTEN
              ? 'cited-often'
              : undefined,
      };
    });
  return {
    reviews: reviews.length,
    findings: findings.length,
    rules: counted,
    criteria: findings.filter((f) => f.rule === undefined && f.criterion !== undefined).length,
    uncited: findings.filter((f) => f.rule === undefined && f.criterion === undefined).length,
  };
}

const SUGGESTS: Record<NonNullable<RuleCount['suggests']>, string> = {
  'could-go': 'never cited: could it go?',
  'cited-often': 'cited often: a lint rule, or an invariant for AGENTS.md?',
};

/** The counts as a table for the terminal. */
export function rulesTable(counts: RuleCounts): string {
  const width = Math.max(4, ...counts.rules.map((r) => r.title.length));
  return [
    `${counts.findings} findings in ${counts.reviews} reviews.`,
    '',
    `rule  cited  blocking  ${'title'.padEnd(width)}`,
    ...counts.rules.map((r) =>
      [
        String(r.number).padEnd(4),
        String(r.cited).padStart(5),
        String(r.blocking).padStart(8),
        r.title.padEnd(width),
        r.suggests ? SUGGESTS[r.suggests] : '',
      ]
        .join('  ')
        .trimEnd(),
    ),
    '',
    `A criterion of the spec and no rule: ${counts.criteria}. Neither: ${counts.uncited}.`,
  ].join('\n');
}
