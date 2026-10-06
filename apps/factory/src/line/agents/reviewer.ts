/**
 * The reviewer: once the gates pass, reviews the pull request's change against the spec and the rules the repository
 * keeps for review, `docs/REVIEWERS.md`, read as it is at the base so that a change cannot loosen the rules it is
 * reviewed by. Each finding is anchored to a line of the change, marked blocking or not, and cites what it holds the
 * change to: a rule's number, a criterion of the spec, or both. Its review is a signal, never a gate.
 *
 * The checkout is the pull request's head, with its base beside it as the branch `base` and every commit between
 * (the runner fetches them: `readsChange`), so `git diff base` is the change and `git log base..HEAD` holds what the
 * coder said of it in each round. The reviewer holds the coder's claims to the diff, not the other way round: a
 * criterion nothing in the change meets blocks, whatever the note says.
 *
 * It asks for nothing outside the ticket: the shop is bad on purpose, and a coder that fixed other defects in passing
 * would muddle what the fix did. It judges; it does not run the gates again, which have passed by the time it starts.
 * A later review is a fresh reviewer, told what the review before it blocked on, so that it checks those first.
 *
 * Its result goes to GitHub through the GitHub worker (`../review.ts`): the check run first, which is harmless to
 * make twice, then the comment review, which is not; each is done once for a handback (`EffectsContext.once`), so
 * GitHub failing between them tries only what is left, and never runs the reviewer again.
 */
import { MAX_FINDINGS, type PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import { LIMITS } from '../machine.ts';
import { cites, type Finding, reviewInGitHub } from '../review.ts';
import { defineAgent, need, words } from './agent.ts';

export interface ReviewerInput {
  workItem: string;
  spec: PayloadOf<'spec.written'>;
  pullRequest: number;
  /** The pull request's title, as the coder wrote it. */
  title: string;
  /** The coder's round the change is from: 1, or a later one sent back by review, the gates or Martin. */
  round: number;
  /** What the review before this one blocked on, for a later review. */
  blocked?: Finding[] | undefined;
}

const finding = z.strictObject({
  /** A file the change changes, from the repository's root. */
  path: words(200),
  /** A line in the change's version of the file, that the diff shows. */
  line: z.number().int().positive(),
  blocking: z.boolean(),
  /** The number of the rule in `docs/REVIEWERS.md` it cites. */
  rule: z.number().int().min(1).max(50).optional(),
  /** The number of the spec's criterion it cites. */
  criterion: z.number().int().min(1).max(12).optional(),
  /** What is wrong and what would put it right. Each finding reaches the events whole, so it is short. */
  comment: words(300),
});

const VERDICTS = ['approved', 'changes-requested', 'escalated'] as const;

/** The result, with criteria numbered up to `criteria`: a finding that cites one the spec does not have is refused. */
export function reviewerResult(criteria = 12) {
  return z
    .strictObject({
      verdict: z.enum(VERDICTS),
      /** The review's summary, which the events, the console and the pull request carry. */
      note: words(300),
      findings: z.array(finding).max(MAX_FINDINGS),
    })
    .superRefine(({ verdict, findings }, ctx) => {
      const blocking = findings.some((f) => f.blocking);
      if (verdict === 'approved' && blocking) {
        ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'an approval with a blocking finding' });
      }
      if (verdict === 'changes-requested' && !blocking) {
        ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'changes requested with nothing blocking' });
      }
      findings.forEach((f, i) => {
        if (f.criterion !== undefined && f.criterion > criteria) {
          const message = `the spec has ${criteria} criteria, not ${f.criterion}`;
          ctx.addIssue({ code: 'custom', path: ['findings', i, 'criterion'], message });
        }
      });
    });
}

export type ReviewerResult = z.infer<ReturnType<typeof reviewerResult>>;

const where = (f: Finding) => `${f.path}:${f.line}${cites(f) ? ` (${cites(f)})` : ''}`;

function prompt({ workItem, spec, pullRequest, title, round, blocked }: ReviewerInput): string {
  return [
    `Review pull request #${pullRequest}, the factory’s fix for ticket #${workItem}: “${title}”${round > 1 ? `, in its round ${round}` : ''}.`,
    '',
    'The checkout is the pull request’s head. Its base is the branch `base`: `git diff base` is the change, and `git log base..HEAD` holds the coder’s commit messages, which say what it claims to have done. Hold those claims to the diff, not the other way round.',
    '',
    'The spec the change is held to:',
    `Outcome: ${spec.outcome}`,
    'Acceptance criteria:',
    ...spec.criteria.map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.expect}.`),
    `Scope, the only files it may change: ${spec.scope.join(', ')}.`,
    ...(blocked?.length
      ? [
          '',
          'The review before this one blocked on these. Check each first: is it put right?',
          ...blocked.map((f) => `- ${where(f)}: ${f.comment}`),
        ]
      : []),
    '',
    'How to review:',
    '1. Read the rules as they are at the base, so the change cannot loosen them: `git show base:docs/REVIEWERS.md`, and `git show base:AGENTS.md`, whose rules hold for every change.',
    '2. Read the whole diff. For each criterion, find the code that meets it and the test that shows it. A criterion that nothing in the change meets is a blocking finding that cites it, whatever the commit messages say.',
    '3. Hold the change to each rule. A finding about a rule cites its number.',
    '4. Review the diff, not the code around it. The shop is bad on purpose: ask for nothing outside the ticket, and nothing outside the scope.',
    'The gates have passed: the tests, types and lint are green, so do not run them again, and do not start the app or send it requests. Read a test to see what it shows.',
    '',
    `Anchor each finding to a line the diff shows in the change’s version of a file it changes, and give at most ${MAX_FINDINGS}. A finding blocks only if the change is wrong without it: a criterion not met, a rule broken, a test that does not show what it claims. Taste is a suggestion. Say in each comment, in at most 300 characters, what is wrong and what would put it right.`,
    '',
    'The verdict:',
    '- approved: nothing blocks. Suggestions may stay.',
    '- changes-requested: something blocks that the coder can put right inside the scope.',
    '- escalated: something blocks that the coder cannot put right inside the scope, such as a criterion that only a file outside it can meet. Martin decides.',
    '',
    'Then write the result, {"verdict","note","findings":[{"path","line","blocking","rule","criterion","comment"}]}:',
    '- `note`: the review in one or two short sentences, for the pull request and the console: at most 300 characters, or the result is refused. Leave the detail to the findings.',
    '- `rule` and `criterion`: numbers, each left out when the finding cites none.',
  ].join('\n');
}

/** The branch every factory pull request is opened onto (`coder.ts`), which its change is compared with. */
const MAIN = 'main';

export const reviewer = defineAgent<ReviewerInput, ReviewerResult>({
  agent: 'reviewer',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  readsChange: true,
  input: ({ workItem, state, round }) => {
    const pushed = need(state.pullRequest, 'a pull request');
    return {
      workItem,
      spec: need(state.spec, 'a spec'),
      pullRequest: pushed.number,
      title: pushed.title,
      round,
      // A later review checks first what the review before it blocked on.
      blocked: state.reviews.at(-1)?.findings.filter((f) => f.blocking),
    };
  },
  schema: ({ spec }) => reviewerResult(spec.criteria.length),
  prompt,
  apply: async (review, _handback, { pullRequest }, context) => {
    const { workItem, commit, state } = context;
    // The files the change touches, as GitHub's diff of the pull request shows them, to anchor the findings to.
    const { files } = await context.read('comparison', { base: MAIN, head: commit });
    const number = state.reviews.length + 1;
    const shown = reviewInGitHub(review, files, { commit, workItem, review: number, last: number >= LIMITS.reviews });
    await context.once('check-run', () => context.act('createCheckRun', shown.check));
    await context.once('review', () =>
      context.act('review', { number: pullRequest, commit, body: shown.body, comments: shown.comments }),
    );
    return [
      {
        type: 'review.submitted',
        actor: 'reviewer',
        summary: `Review of PR #${pullRequest}: ${shown.check.title}`.slice(0, 200),
        payload: { pullRequest, verdict: review.verdict, note: review.note, findings: review.findings },
      },
    ];
  },
});
