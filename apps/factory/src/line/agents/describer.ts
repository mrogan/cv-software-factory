/**
 * The describer: once review has approved a fix, writes about it with a fresh context, because the coder's is full of
 * dead ends. It writes the pull request's title and description, which the line publishes as it makes the pull request
 * ready for Martin, and the work item's summary for the console: a title, two lines for its card and the paragraph at
 * the top of its sheet, the story of the work item from the ticket to the wait for Martin's merge.
 *
 * It reads what a reviewer of the pull request would want explained: the ticket and what the senses saw, by their
 * typed fields (`evidence.ts`), never a visitor's words; the spec; the final diff and the coder's commit messages, from
 * the checkout, whose base is the branch `base`; and the review thread, round by round, with each time the work went
 * back to Build.
 *
 * It names the runner's `visual-pr` skill, which says how to fit a description to its change: a line if a line will
 * do, a diagram when the change has a shape worth seeing, and the repository's pull request template read as the
 * questions a reviewer there expects answered, not headings to fill. The description is Markdown, so the agent writes
 * it as a file of its own beside the result, not inside the JSON.
 *
 * The line publishes the description as the agent wrote it, and the squash commit takes it as its message, so the
 * schema refuses what would act from the App's account: a closing keyword, which would close the ticket's issue on
 * merge, before the fix is verified in production, and an @mention, which would notify someone. The line adds the
 * line that refers to the issue itself. The title and the description are set before the pull request leaves draft,
 * each once for a handback (`EffectsContext.once`).
 */
import type { PayloadOf, Stage } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { cites } from '../review.ts';
import { answerOf, closesAnIssue, commitTitle, defineAgent, mentions, need, words } from './agent.ts';
import { refersTo } from './coder.ts';
import { type Signal, seen, ticketLines } from './evidence.ts';

export type Review = PayloadOf<'review.submitted'>;

export interface DescriberInput {
  workItem: string;
  /** The ticket, as its public view has it. */
  ticket: PayloadOf<'ticket.opened'>;
  /** What each sense saw, in the order they saw it. A report's signal is not here. */
  signals: Signal[];
  spec: PayloadOf<'spec.written'>;
  pullRequest: number;
  /** The pull request's title, as the coder wrote it. */
  title: string;
  /** Every review of the change, in order: the last approved it. */
  reviews: Review[];
  /** Each time the work went back to Build, in order, and why. */
  returns: { from: Stage; reason: string }[];
  /** Martin's answer to the hold before this step, if he wrote one. */
  answer?: string | undefined;
  /** Why the step's last attempt failed, if it did. */
  failure?: string | null | undefined;
}

export const describerResult = z.strictObject({
  /** The pull request's title, and so its squash commit's headline. */
  title: commitTitle,
  /** Its description, in Markdown: written by the agent as a file of its own, and read into the result. */
  body: words(30_000)
    .refine((body) => !closesAnIssue(body), 'no closing keyword before an issue: the issue closes once verified')
    .refine((body) => !mentions(body), 'no @mention outside code: it would notify someone from the App’s account'),
  summary: PAYLOADS['work-item.summarised'],
});

export type DescriberResult = z.infer<typeof describerResult>;

const VERDICT: Record<Review['verdict'], string> = {
  approved: 'approved it',
  'changes-requested': 'asked for changes',
  escalated: 'escalated it',
};

/** The review thread, as lines of the prompt: each review's verdict and note, then its findings. */
function thread(reviews: Review[]): string[] {
  return reviews.flatMap((review, i) => [
    `- Review ${i + 1} ${VERDICT[review.verdict]}: ${review.note}`,
    ...review.findings.map(
      (f) =>
        `  - ${f.blocking ? 'Blocking' : 'Suggestion'} at ${f.path}:${f.line}${cites(f) ? ` (${cites(f)})` : ''}: ${f.comment}`,
    ),
  ]);
}

function prompt(input: DescriberInput): string {
  const { workItem, ticket, signals, spec, pullRequest, title, reviews, returns, answer, failure } = input;
  const rounds = returns.length + 1;
  // A return from review is in the thread already, with its findings.
  const otherReturns = returns.filter((r) => r.from !== 'review');
  return [
    `Describe pull request #${pullRequest}, the factory’s fix for ticket #${workItem}: “${title}”. Its gates and its review have passed it, and it waits for Martin to merge it.`,
    '',
    'The checkout is the pull request’s head. Its base is the branch `base`: `git diff base` is the change, and `git log base..HEAD` holds the coder’s commit messages, its own note of what was wrong and what it changed.',
    '',
    `The ticket: ${ticket.title}.`,
    ...ticketLines(ticket),
    ...(signals.length ? ['', 'What the senses saw:', ...signals.flatMap(seen)] : []),
    '',
    'The spec the change is held to:',
    `Outcome: ${spec.outcome}`,
    'Acceptance criteria:',
    ...spec.criteria.map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.expect}.`),
    `Scope: ${spec.scope.join(', ')}.`,
    `Risks the planner tagged: ${spec.risks.length ? spec.risks.join(', ') : 'none'}.`,
    `Rollout: ${spec.rollout}`,
    '',
    `How it went: the coder took ${rounds === 1 ? 'one round' : `${rounds} rounds`}.`,
    ...otherReturns.map((r) => `- It went back to Build from ${r.from}: ${r.reason}`),
    'The review thread:',
    ...thread(reviews),
    '',
    ...(answer ? [`Martin answered the hold before this step: ${answer}`, ''] : []),
    ...(failure
      ? [`Your last attempt at this description failed: ${failure}. Do not hand back the same again.`, '']
      : []),
    'The gates and the reviewer have passed the change: do not run the tests, start the app, send it requests or change anything. Read what you need to explain it, and no more.',
    '',
    'Write three things.',
    '',
    '1. The pull request’s description, with the visual-pr skill, which says how. It replaces the draft’s, which held the spec: give a reviewer what they need of the spec, such as which test shows each criterion, not the spec again. Mention a suggestion the review left only if the change leaves it unanswered. The line adds the line that refers to the ticket’s issue, so leave that out, and write no closing keyword before an issue (“Fixes #12”): the issue closes once the fix is verified in production, not on merge. Mention nobody with an @ outside code.',
    '',
    '2. The pull request’s title: a Conventional Commit of at most 80 characters, such as "fix(cart): count the last item". It becomes the squash commit’s headline. Keep the coder’s if it says what the change does.',
    '',
    '3. The work item’s summary, for the factory’s console. Anyone may read it, someone who has never seen a pull request among them, so write plain sentences with no Markdown and no code:',
    '- `title`: what was wrong, as a visitor to the shop would see it, in a few words, at most 120 characters, such as "Prices lose a digit of pence".',
    '- `description`: two short sentences for the work item’s card, at most 260 characters: what was wrong, and that the fix waits for Martin to merge it.',
    '- `story`: one paragraph, at most 1200 characters, in the past tense: what the senses saw, what the planner’s spec asked for, how the coder wrote a failing test and then the fix, what the gates and the reviewer said in each round, and that it now waits for Martin’s merge.',
    '',
    'Then write the result, {"title","summary":{"title","description","story"}}, and the description as its own file: the system prompt says where each goes.',
  ].join('\n');
}

export const describer = defineAgent<DescriberInput, DescriberResult>({
  agent: 'describer',
  skill: 'visual-pr',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  readsChange: true,
  resultFiles: { body: 'description.md' },
  input: async ({ workItem, state, failure, ticket, signals }) => {
    const pushed = need(state.pullRequest, 'a pull request');
    return {
      workItem,
      ticket: await ticket(),
      signals: await signals(),
      spec: need(state.spec, 'a spec'),
      pullRequest: pushed.number,
      title: pushed.title,
      reviews: state.reviews,
      returns: state.returns,
      answer: answerOf(state),
      failure,
    };
  },
  schema: () => describerResult,
  prompt,
  apply: async (described, _handback, { pullRequest: number }, context) => {
    const pr = await context.read('pullRequest', { number });
    // The description first: the pull request leaves draft with it, never with the draft's.
    await context.once('description', () =>
      context.act('updatePullRequest', {
        number,
        title: described.title,
        body: `${described.body}\n\n${refersTo(context.issue)}`.trim(),
      }),
    );
    if (pr.draft) {
      await context.once('ready', () =>
        context.act('readyForReview', { pullRequest: { number, url: '', nodeId: pr.nodeId } }),
      );
    }
    return [
      { type: 'work-item.summarised', actor: 'describer', summary: 'Summary written', payload: described.summary },
    ];
  },
});
