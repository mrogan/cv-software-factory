/**
 * The reviewer: reviews the pull request's diff against the spec and the repository's `docs/REVIEWERS.md` at the
 * base, once the gates pass. Its findings are anchored to lines, marked blocking or not, and cite their rule; its
 * verdict approves, asks for changes, or escalates to Martin. Its review is a signal, never a gate.
 *
 * The prompt here is the least that does the job; milestone 5's task 12 writes the reviewer properly.
 */
import { MAX_FINDINGS, type PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import { defineAgent, need, words } from './agent.ts';

export interface ReviewerInput {
  workItem: string;
  spec: PayloadOf<'spec.written'>;
  pullRequest: number;
  /** The commit the pull request is built on, which the diff is against. */
  base: string;
}

export const reviewerResult = z.strictObject({
  verdict: z.enum(['approved', 'changes-requested', 'escalated']),
  note: words(300),
  findings: z
    .array(
      z.strictObject({
        path: words(400),
        /** The line in the change's version of the file. */
        line: z.number().int().positive(),
        body: words(4000),
        blocking: z.boolean(),
        /** The number of the rule in `docs/REVIEWERS.md` it cites. */
        rule: z.number().int().positive().max(50).optional(),
      }),
    )
    .max(50),
});

export type ReviewerResult = z.infer<typeof reviewerResult>;

export const reviewer = defineAgent<ReviewerInput, ReviewerResult>({
  agent: 'reviewer',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  input: ({ workItem, state, base }) => ({
    workItem,
    spec: need(state.spec, 'a spec'),
    pullRequest: need(state.pullRequest, 'a pull request').number,
    base,
  }),
  schema: () => reviewerResult,
  prompt: ({ workItem, spec, pullRequest, base }) =>
    [
      `Review pull request #${pullRequest}, the fix for ticket #${workItem}: the diff from ${base} to the checkout's head.`,
      `It should do this: ${spec.outcome}`,
      `It may change only: ${spec.scope.join(', ')}.`,
      'Review it against docs/REVIEWERS.md as it is at the base. Ask for nothing outside the ticket.',
      'The result is {"verdict","note","findings":[{"path","line","body","blocking","rule"}]}; the verdict is approved, changes-requested or escalated.',
    ].join('\n'),
  apply: async (review, _handback, { pullRequest: number }, context) => {
    await context.once('review', () =>
      context.act('review', {
        number,
        commit: context.commit,
        body: review.note,
        comments: review.findings.map((f) => ({
          path: f.path,
          line: f.line,
          body: `${f.blocking ? 'Blocking' : 'Suggestion'}${f.rule ? ` · rule ${f.rule}` : ''}: ${f.body}`,
        })),
      }),
    );
    return [
      {
        type: 'review.submitted',
        actor: 'reviewer',
        summary: `Review of PR #${number}: ${review.verdict.replace('-', ' ')}`,
        payload: {
          pullRequest: number,
          verdict: review.verdict,
          note: review.note,
          findings: review.findings.slice(0, MAX_FINDINGS).map(({ path, line, blocking, rule, body }) => ({
            path,
            line,
            blocking,
            rule,
            comment: body.slice(0, 300),
          })),
        },
      },
    ];
  },
});
