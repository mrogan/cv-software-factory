/**
 * The coder: writes the failing test, then the fix, inside the spec's scope, and hands back the patch with a note.
 * A later round resumes its own session with what sent it back. Its result is the pull request's title.
 *
 * The prompt here is the least that does the job; milestone 5's task 11 writes the coder properly.
 */
import type { PayloadOf, Stage } from '@software-factory/events';
import { z } from 'zod';
import type { AgentDefinition } from './agent.ts';

export interface CoderInput {
  workItem: string;
  spec: PayloadOf<'spec.written'>;
  round: number;
  /** What sent the work back, for a later round. */
  returned?: { from: Stage; reason: string } | undefined;
}

export const coderResult = z.strictObject({
  /** The pull request's title, and its commit's headline, as a Conventional Commit. */
  title: z
    .string()
    .trim()
    .regex(
      /^(fix|test|refactor|perf)(\([a-z0-9-]+\))?: \S.{0,70}$/,
      'a Conventional Commit title of 80 characters at most',
    ),
});

export type CoderResult = z.infer<typeof coderResult>;

export const coder: AgentDefinition<CoderInput, CoderResult> = {
  agent: 'coder',
  maxTurns: 60,
  deadlineSeconds: 30 * 60,
  result: coderResult,
  prompt: ({ workItem, spec, round, returned }) =>
    round > 1 && returned
      ? [
          `Your change for ticket #${workItem} came back from ${returned.from}: ${returned.reason}.`,
          'Put it right, inside the same scope, and run the tests again.',
          'The result is {"title"}: the pull request’s title as a Conventional Commit.',
        ].join('\n')
      : [
          `Ticket #${workItem}. ${spec.outcome}`,
          'Acceptance criteria:',
          ...spec.criteria.map((c) => `- Given ${c.given}, when ${c.when}, then ${c.expect}.`),
          `You may change only: ${spec.scope.join(', ')}.`,
          '',
          'Write a test that fails because of the defect, and run it to see it fail. Then fix the code, and run the test again to see it pass.',
          'The result is {"title"}: the pull request’s title as a Conventional Commit, such as "fix(cart): count the last item".',
        ].join('\n'),
};
