/**
 * A review as GitHub shows it: a comment review, with each finding anchored to its line, and a check run beside it.
 * Both are signals, never gates: the review only comments, so it never counts toward a merge, and the check run is
 * one no ruleset requires, which the line leaves out of the gates it reads (`gates.ts`).
 *
 * GitHub refuses a whole review if one comment is anchored to a line the pull request's diff does not show, so each
 * finding is checked against the diff first. One anchored elsewhere is not lost: it goes in the review's body, with
 * where the reviewer put it.
 */
import type { PayloadOf } from '@software-factory/events';
import type { CheckRunReport, ReviewComment } from '../github/actions.ts';
import type { Comparison } from '../github/reads.ts';
import type { ReviewerResult } from './agents/reviewer.ts';

export type Finding = PayloadOf<'review.submitted'>['findings'][number];

/** What a finding cites, as a reader sees it: "rule 4 · criterion 2". */
export const cites = (f: Pick<Finding, 'rule' | 'criterion'>) =>
  [f.rule && `rule ${f.rule}`, f.criterion && `criterion ${f.criterion}`].filter(Boolean).join(' · ');

/** The factory's check run, by name. */
export const REVIEW_CHECK = 'factory review';

/**
 * For each file a comparison changes, the lines of its new version the diff shows (added, or kept around a change):
 * the lines a review comment can be anchored to.
 */
export function shownLines(files: Comparison['files']): Map<string, Set<number>> {
  const shown = new Map<string, Set<number>>();
  for (const { path, patch } of files) {
    const lines = new Set<number>();
    let line = 0;
    for (const text of (patch ?? '').split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) line = Number(hunk[1]);
      else if (line && (text.startsWith('+') || text.startsWith(' '))) lines.add(line++);
    }
    shown.set(path, lines);
  }
  return shown;
}

export interface ReviewInGitHub {
  body: string;
  comments: ReviewComment[];
  check: CheckRunReport;
}

const mark = (f: Finding) => `**${f.blocking ? 'Blocking' : 'Suggestion'}**${cites(f) ? ` · ${cites(f)}` : ''}`;

const CONCLUSIONS: Record<ReviewerResult['verdict'], NonNullable<CheckRunReport['conclusion']>> = {
  approved: 'success',
  'changes-requested': 'failure',
  escalated: 'neutral',
};

const TITLES: Record<ReviewerResult['verdict'], (blocking: number) => string> = {
  approved: () => 'Approved',
  'changes-requested': (n) => `Changes requested: ${n} blocking ${n === 1 ? 'finding' : 'findings'}`,
  escalated: () => 'Escalated to Martin',
};

/** What becomes of a review, as its body ends by saying. */
function after(verdict: ReviewerResult['verdict'], last: boolean): string {
  if (verdict === 'approved') return 'the change goes on to its description and Martin’s merge';
  if (verdict === 'escalated') return 'it is escalated, and Martin decides';
  return last
    ? 'this was the last review the line allows, so Martin decides'
    : 'the blocking findings go back to the coder';
}

/**
 * The review and check run a reviewer's result makes on the commit it reviewed, given the pull request's diff.
 * `review` counts the pull request's reviews, this one included, and `last` says it is the last the line allows.
 */
export function reviewInGitHub(
  review: ReviewerResult,
  files: Comparison['files'],
  { commit, workItem, review: number, last }: { commit: string; workItem: string; review: number; last: boolean },
): ReviewInGitHub {
  const shown = shownLines(files);
  const anchored = review.findings.filter((f) => shown.get(f.path)?.has(f.line));
  const elsewhere = review.findings.filter((f) => !anchored.includes(f));
  const blocking = review.findings.filter((f) => f.blocking).length;
  const listed = (f: Finding) => `- \`${f.path}:${f.line}\`: ${mark(f)}: ${f.comment}`;
  const body = [
    review.note,
    ...(elsewhere.length ? ['', 'Not on a line the diff shows:', '', ...elsewhere.map(listed)] : []),
    '',
    `_The factory’s reviewer, review ${number}. A signal, never a gate: ${after(review.verdict, last)}._`,
  ].join('\n');
  return {
    body,
    comments: anchored.map((f) => ({ path: f.path, line: f.line, body: `${mark(f)}\n\n${f.comment}` })),
    check: {
      name: REVIEW_CHECK,
      headSha: commit,
      status: 'completed',
      conclusion: CONCLUSIONS[review.verdict],
      title: TITLES[review.verdict](blocking),
      summary: [review.note, ...(review.findings.length ? ['', ...review.findings.map(listed)] : [])].join('\n'),
      externalId: workItem,
    },
  };
}
