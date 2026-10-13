/**
 * The reviewer: once the gates pass, reviews the pull request's change against the spec and the rules the repository
 * keeps for review, `docs/REVIEWERS.md`, read as it is at the base so that a change cannot loosen the rules it is
 * reviewed by. Each finding is anchored to a line of the change, marked blocking or not, and cites what it holds the
 * change to: a rule's number, a criterion of the spec, the ticket, or more than one. Its review is a signal, never a
 * gate.
 *
 * It holds the spec to the ticket as well as the change to the spec: it is told the ticket, what the senses saw and
 * Martin's answers at Plan, as the planner was (`evidence.ts`). The two go different ways:
 * - A criterion they do not ask for is a blocking finding that cites that criterion and the ticket, and the review is
 *   escalated: the coder cannot put a spec right, so it goes to Martin, in every autonomy mode. The schema holds the
 *   verdict to it, whatever the model chose.
 * - A change that goes beyond the spec, when the spec is sound, is an ordinary blocking finding, citing the spec or a
 *   rule: the coder can take it out, so the work goes back to it.
 *
 * The checkout is the pull request's head, with its base beside it as the branch `base` and every commit between
 * (the runner fetches them: `readsChange`), so `git diff base` is the change and `git log base..HEAD` holds what the
 * coder said of it in each round. The reviewer holds the coder's claims to the diff, not the other way round: a
 * criterion nothing in the change meets blocks, whatever the note says.
 *
 * It asks for nothing outside the ticket: the shop is bad on purpose, and a coder that fixed other defects in passing
 * would muddle what the fix did. It judges; it does not run the gates again, which have passed by the time it starts.
 * A later review is a fresh reviewer, told what the review before it blocked on, so that it checks those first, and
 * what it suggested, less the suggestions the coder declined, which it is told apart with the coder's reasons. It
 * says by number which of them the change now answers: a finding put right, or a suggestion taken. The GitHub worker
 * replies on each of those threads with the commit that answered it and resolves it, since the app's `main` merges
 * nothing with a thread open; one the reviewer still holds stays open.
 *
 * Its result goes to GitHub through the GitHub worker (`../review.ts`): the check run first, which is harmless to
 * make twice, then the comment review, which is not, then the answered threads; each is done once for a handback
 * (`EffectsContext.once`), so GitHub failing between them tries only what is left, and never runs the reviewer again.
 */
import { MAX_FINDINGS, type PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import { LIMITS, suggestionsGoBack, type WorkItemState } from '../machine.ts';
import { answerThreads, cites, type Finding, lineage, reviewInGitHub, threadAnswers } from '../review.ts';
import { defineAgent, need, words } from './agent.ts';
import { numbered, type Signal, ticketLines } from './evidence.ts';

export interface ReviewerInput {
  workItem: string;
  /** The ticket, as its public view has it. */
  ticket: PayloadOf<'ticket.opened'>;
  /** What each sense saw, in the order they saw it. A report's signal is not here. */
  signals: Signal[];
  /** Martin's answers to the holds at Plan, each with what he was asked: part of what the ticket asks. */
  answers: { asked: string; answer: string }[];
  spec: PayloadOf<'spec.written'>;
  pullRequest: number;
  /** The pull request's title, as the coder wrote it. */
  title: string;
  /** The coder's round the change is from: 1, or a later one sent back by review, the gates or Martin. */
  round: number;
  /** What the review before this one blocked on, for a later review. */
  blocked?: Finding[] | undefined;
  /** What the review before this one suggested, less those the coder declined: the change may have taken them. */
  suggested?: Finding[] | undefined;
  /** The suggestions of the review before this one that the coder declined, each with its reason. */
  declined?: { finding: Finding; reason: string }[] | undefined;
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
  /**
   * It cites the ticket: the criterion it cites is one the ticket does not ask for. Only a criterion of the spec can
   * go beyond the ticket; a change beyond the spec cites the spec. A model may write `false` for no; only `true` is
   * kept.
   */
  ticket: z.boolean().optional(),
  /**
   * In a later review, the number of the finding of the review before that this one holds again, in its words or new:
   * answering this one later answers that one's thread too.
   */
  holds: z.number().int().min(1).max(MAX_FINDINGS).optional(),
  /** What is wrong and what would put it right. Each finding reaches the events whole, so it is short. */
  comment: words(300),
});

const VERDICTS = ['approved', 'changes-requested', 'escalated'] as const;

/**
 * The result, with criteria numbered up to `criteria`: a finding that cites one the spec does not have is refused.
 * `earlier` counts what the review before blocked on and suggested, less what the coder declined: the findings a
 * later review may say are answered.
 */
export function reviewerResult(criteria = 12, earlier = 0) {
  return z
    .strictObject({
      verdict: z.enum(VERDICTS),
      /** The review's summary, which the events, the console and the pull request carry. */
      note: words(300),
      findings: z.array(finding).max(MAX_FINDINGS),
      /**
       * In a later review, the numbers of the findings of the review before that the change now answers: one it blocked
       * on put right, or a suggestion taken. One it still holds is left out. A first review has none to answer, and may
       * leave it out.
       */
      answered: z.array(z.number().int().min(1).max(MAX_FINDINGS)).max(MAX_FINDINGS).optional(),
    })
    .superRefine(({ verdict, findings, answered = [] }, ctx) => {
      answered.forEach((n, i) => {
        if (n > earlier) {
          const message = earlier
            ? `the review before left ${earlier} findings to answer, not ${n}`
            : 'there is no review before this one to answer';
          ctx.addIssue({ code: 'custom', path: ['answered', i], message });
        } else if (answered.indexOf(n) !== i) {
          ctx.addIssue({ code: 'custom', path: ['answered', i], message: `finding ${n} is answered twice` });
        }
      });
      const blocking = findings.some((f) => f.blocking);
      if (verdict === 'approved' && blocking) {
        ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'an approval with a blocking finding' });
      }
      if (verdict === 'changes-requested' && !blocking) {
        ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'changes requested with nothing blocking' });
      }
      findings.forEach((f, i) => {
        if (f.holds !== undefined && f.holds > earlier) {
          const message = earlier
            ? `the review before left ${earlier} findings to answer, not ${f.holds}`
            : 'there is no review before this one to hold';
          ctx.addIssue({ code: 'custom', path: ['findings', i, 'holds'], message });
        } else if (f.holds !== undefined && answered.includes(f.holds)) {
          const message = `finding ${f.holds} is answered, so this one cannot hold it`;
          ctx.addIssue({ code: 'custom', path: ['findings', i, 'holds'], message });
        }
        if (f.criterion !== undefined && f.criterion > criteria) {
          const message = `the spec has ${criteria} criteria, not ${f.criterion}`;
          ctx.addIssue({ code: 'custom', path: ['findings', i, 'criterion'], message });
        }
        // A criterion beyond the ticket is never a suggestion, and never the coder's to put right.
        if (f.ticket && !f.blocking) {
          const message = 'a finding that cites the ticket blocks';
          ctx.addIssue({ code: 'custom', path: ['findings', i, 'blocking'], message });
        }
        if (f.ticket && f.criterion === undefined) {
          const message =
            'a finding cites the ticket for a criterion of the spec; a change beyond the spec cites the spec';
          ctx.addIssue({ code: 'custom', path: ['findings', i, 'criterion'], message });
        }
      });
      if (verdict !== 'escalated' && findings.some((f) => f.ticket)) {
        const message = 'a finding that cites the ticket is escalated to Martin: the coder cannot put a spec right';
        ctx.addIssue({ code: 'custom', path: ['verdict'], message });
      }
    });
}

export type ReviewerResult = z.infer<ReturnType<typeof reviewerResult>>;

const where = (f: Finding) => `${f.path}:${f.line}${cites(f) ? ` (${cites(f)})` : ''}`;

function prompt({
  workItem,
  ticket,
  signals,
  answers,
  spec,
  pullRequest,
  title,
  round,
  blocked = [],
  suggested = [],
  declined = [],
}: ReviewerInput): string {
  const earlier = blocked.length + suggested.length;
  return [
    `Review pull request #${pullRequest}, the factory’s fix for ticket #${workItem}: “${title}”${round > 1 ? `, in its round ${round}` : ''}.`,
    '',
    'The checkout is the pull request’s head. Its base is the branch `base`: `git diff base` is the change, and `git log base..HEAD` holds the coder’s commit messages, which say what it claims to have done. Hold those claims to the diff, not the other way round.',
    '',
    `The ticket: ${ticket.title}.`,
    ...ticketLines(ticket, signals),
    ...(signals.length ? ['', 'What the senses saw, by number:', ...numbered(signals)] : []),
    ...(answers.length
      ? [
          '',
          'Martin was asked, as the planner planned, and answered. His answers are part of what the ticket asks:',
          ...answers.map((a) => `- ${a.asked} He said: ${a.answer}`),
        ]
      : []),
    '',
    'The spec the change is held to, which the planner wrote from the ticket:',
    `Outcome: ${spec.outcome}`,
    'Acceptance criteria, each with what the planner said asks for it:',
    ...spec.criteria.map(
      (c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.expect}.${c.from ? ` (From ${c.from}.)` : ''}`,
    ),
    `Scope, the only files it may change: ${spec.scope.join(', ')}.`,
    ...(blocked.length
      ? [
          '',
          'The review before this one blocked on these. Check each first: is it put right?',
          ...blocked.map((f, i) => `${i + 1}. ${where(f)}: ${f.comment}`),
        ]
      : []),
    ...(suggested.length
      ? [
          '',
          `${blocked.length ? 'It also suggested' : 'The review before this one approved, and suggested'} these, which do not block. Check each: has the change taken it?`,
          ...suggested.map((f, i) => `${blocked.length + i + 1}. ${where(f)}: ${f.comment}`),
        ]
      : []),
    ...(declined.length
      ? [
          '',
          'The coder declined these suggestions, and their threads are answered with its reasons. Give one again only if its reason does not hold:',
          ...declined.map(({ finding, reason }) => `- ${where(finding)}: ${finding.comment} The coder said: ${reason}`),
        ]
      : []),
    '',
    'How to review:',
    '1. Read the rules as they are at the base, so the change cannot loosen them: `git show base:docs/REVIEWERS.md`, and `git show base:AGENTS.md`, whose rules hold for every change.',
    '2. Hold the spec to the ticket. A fix does what the ticket, what the senses saw and Martin’s answers ask, and no more, in every autonomy mode. A criterion they do not ask for (another defect, a new behaviour, a tidy-up) is a blocking finding that cites that criterion with `"ticket":true`, whatever the planner said it is from. Anchor it to the code or test in the diff that meets that criterion, or to the change itself.',
    '3. Read the whole diff. For each criterion, find the code that meets it and the test that shows it. A criterion that nothing in the change meets is a blocking finding that cites it, whatever the commit messages say. A change that does more than the spec’s criteria ask, when the spec itself is sound, is an ordinary blocking finding that cites the criterion it goes beyond, or a rule, without `"ticket"`: the coder can take it out.',
    '4. Hold the change to each rule. A finding about a rule cites its number.',
    '5. Review the diff, not the code around it. The shop is bad on purpose: ask for nothing outside the ticket, and nothing outside the scope.',
    'The gates have passed: the tests, types and lint are green, so do not run them again, and do not start the app or send it requests. Read a test to see what it shows.',
    '',
    `Anchor each finding to a line the diff shows in the change’s version of a file it changes, and give at most ${MAX_FINDINGS}. A finding blocks only if the change is wrong without it: a criterion not met, a rule broken, a test that does not show what it claims. Taste is a suggestion. Say in each comment, in at most 300 characters, what is wrong and what would put it right.`,
    '',
    'The verdict:',
    '- approved: nothing blocks. Suggestions may stay.',
    '- changes-requested: something blocks that the coder can put right inside the scope.',
    '- escalated: something blocks that the coder cannot put right inside the scope, such as a criterion that only a file outside it can meet, or any finding with `"ticket":true`, since the coder cannot put a spec right. Martin decides.',
    '',
    `Then write the result, {"verdict","note","findings":[{"path","line","blocking","rule","criterion","ticket",${earlier ? '"holds",' : ''}"comment"}]${earlier ? ',"answered"' : ''}}:`,
    '- `note`: the review in one or two short sentences, for the pull request and the console: at most 300 characters, or the result is refused. Leave the detail to the findings.',
    '- `rule` and `criterion`: numbers, each left out when the finding cites none. `ticket`: true only when the criterion the finding cites is one the ticket does not ask for, and left out otherwise.',
    ...(suggested.length
      ? [
          '- `answered`: the numbers of those above that the change now answers, a finding it puts right or a suggestion it has taken, such as `[1]`, or `[]` for none. Their threads are resolved on the pull request. Leave out one that still blocks, and give it again as a finding of this review.',
        ]
      : blocked.length
        ? [
            '- `answered`: the numbers of the findings the review before blocked on that the change now puts right, such as `[1]`, or `[]` for none. Its threads are resolved on the pull request. Leave out one that still blocks, and give it again as a finding of this review.',
          ]
        : []),
    ...(earlier
      ? [
          '- `holds`: on a finding of this review that gives one of those above again, in the same words or new, its number; left out otherwise. A finding held again is never in `answered`.',
        ]
      : []),
  ].join('\n');
}

/**
 * What a later review checks first, from the review before it: what it blocked on, and what it suggested, told apart
 * by whether the coder declined it. A suggestion is numbered among that review's findings that do not block, as the
 * coder was given them.
 */
function earlierOf(state: WorkItemState): Pick<ReviewerInput, 'blocked' | 'suggested' | 'declined'> {
  const findings = state.reviews.at(-1)?.findings;
  if (!findings) return {};
  const suggestions = findings.filter((f) => !f.blocking);
  const reasons = new Map(state.suggestionsAnswered?.declined.map((d) => [d.suggestion, d.reason]));
  const suggested = suggestions.filter((_, i) => !reasons.has(i + 1));
  const declined = suggestions.flatMap((finding, i) => {
    const reason = reasons.get(i + 1);
    return reason === undefined ? [] : [{ finding, reason }];
  });
  return {
    blocked: findings.filter((f) => f.blocking),
    ...(suggested.length ? { suggested } : {}),
    ...(declined.length ? { declined } : {}),
  };
}

/** A finding's place among a review's findings, from 1, or 0 if it is not one of them. */
const placeOf = (findings: readonly Finding[], finding: Finding | undefined) =>
  finding
    ? findings.findIndex(
        (f) =>
          f.path === finding.path &&
          f.line === finding.line &&
          f.blocking === finding.blocking &&
          f.comment === finding.comment,
      ) + 1
    : 0;

/** The branch every factory pull request is opened onto (`coder.ts`), which its change is compared with. */
const MAIN = 'main';

export const reviewer = defineAgent<ReviewerInput, ReviewerResult>({
  agent: 'reviewer',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  readsChange: true,
  input: async ({ workItem, state, round, ticket, signals }) => {
    const pushed = need(state.pullRequest, 'a pull request');
    return {
      workItem,
      ticket: await ticket(),
      signals: await signals(),
      answers: state.answers,
      spec: need(state.spec, 'a spec'),
      pullRequest: pushed.number,
      title: pushed.title,
      round,
      ...earlierOf(state),
    };
  },
  schema: ({ spec, blocked = [], suggested = [] }) =>
    reviewerResult(spec.criteria.length, blocked.length + suggested.length),
  prompt,
  apply: async (result, _handback, { pullRequest, blocked = [], suggested = [] }, context) => {
    const { workItem, commit, state } = context;
    const earlier = [...blocked, ...suggested];
    const before = state.reviews.at(-1)?.findings ?? [];
    // A finding cites the ticket, or says nothing of it. One held again names its place among the findings of the
    // review before, as the events keep them, not its number in the prompt.
    const findings = result.findings.map(({ ticket, holds, ...f }) => {
      const place = holds === undefined ? 0 : placeOf(before, earlier[holds - 1]);
      return { ...f, ...(ticket ? { ticket: true as const } : {}), ...(place ? { holds: place } : {}) };
    });
    const { answered = [], ...rest } = result;
    const review = { ...rest, findings };
    // The files the change touches, as GitHub's diff of the pull request shows them, to anchor the findings to.
    const { files } = await context.read('comparison', { base: MAIN, head: commit });
    const number = state.reviews.length + 1;
    const shown = reviewInGitHub(review, files, {
      commit,
      workItem,
      review: number,
      last: number >= LIMITS.reviews,
      suggestionsBack: suggestionsGoBack(state),
    });
    await context.once('check-run', () => context.act('createCheckRun', shown.check));
    await context.once('review', () =>
      context.act('review', { number: pullRequest, commit, body: shown.body, comments: shown.comments }),
    );
    const answers = answered.flatMap((n) => {
      const finding = earlier[n - 1];
      if (!finding) return [];
      const reply = finding.blocking
        ? `Answered in ${commit}: the factory’s reviewer, review ${number}, finds this put right.`
        : `Taken in ${commit}: the factory’s reviewer, review ${number}, finds this suggestion taken.`;
      // Each earlier finding it held again, in other words, has a thread of its own, answered with it.
      return lineage(state.reviews, finding).map((f) => ({ finding: f, reply }));
    });
    await answerThreads(context, 'answered', pullRequest, threadAnswers(answers, findings));
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
