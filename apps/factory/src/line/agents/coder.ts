/**
 * The coder: writes the failing test, then the fix, inside the spec's scope, and hands back the patch with a note.
 * A later round resumes its own session with what sent it back. Its result is the pull request's title.
 *
 * The prompt here is the least that does the job; milestone 5's task 11 writes the coder properly.
 */
import type { PayloadOf, Stage } from '@software-factory/events';
import { z } from 'zod';
import { filesIn } from '../../github/patches.ts';
import { fence } from '../../runners/scope.ts';
import { answerOf, defineAgent, holdDraft, need, StepFailed } from './agent.ts';

export interface CoderInput {
  workItem: string;
  spec: PayloadOf<'spec.written'>;
  round: number;
  /** What sent the work back, for a later round. */
  returned?: { from: Stage; reason: string } | undefined;
  /** Martin's answer to the hold before this step, if there was one. */
  answer?: string | undefined;
}

export const coderResult = z.strictObject({
  /** The pull request's title, and its commit's headline, as a Conventional Commit. */
  title: z
    .string()
    .trim()
    .max(80)
    .regex(
      /^(fix|test|refactor|perf)(\([a-z0-9-]+\))?: \S.{0,70}$/,
      'a Conventional Commit title of 80 characters at most',
    ),
});

export type CoderResult = z.infer<typeof coderResult>;

export const coder = defineAgent<CoderInput, CoderResult>({
  agent: 'coder',
  maxTurns: 60,
  deadlineSeconds: 30 * 60,
  input: ({ workItem, state, round }) => ({
    workItem,
    spec: need(state.spec, 'a spec'),
    round,
    returned: state.rebuild,
    answer: answerOf(state),
  }),
  // A later round carries on the coder's own session.
  resume: ({ round }, { session }) => (round > 1 ? (session ?? undefined) : undefined),
  schema: () => coderResult,
  prompt: ({ workItem, spec, round, returned, answer }) =>
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
          ...(answer ? [`Martin answered: ${answer}`] : []),
          '',
          'Write a test that fails because of the defect, and run it to see it fail. Then fix the code, and run the test again to see it pass.',
          'The result is {"title"}: the pull request’s title as a Conventional Commit, such as "fix(cart): count the last item".',
        ].join('\n'),
  apply: async ({ title }, handback, { spec, round }, context) => {
    const { workItem, issue, state, commit } = context;
    const { patch } = handback;
    if (!patch) throw new StepFailed('The coder handed back no change');
    const fenced = fence(patch, spec.scope);
    if (!fenced.ok) {
      const reason = `The coder changed files outside the spec’s scope: ${fenced.outside.join(', ')}`.slice(0, 300);
      return [holdDraft('factory', { stage: 'build', kind: 'held', cause: 'scope', reason })];
    }
    const branch = state.pullRequest?.branch ?? branchFor(workItem, need(state.ticket, 'a ticket').title);
    const message = `${title}\n\n${handback.note}`.trim().slice(0, 9_000);
    await context.once('push', async (again) => {
      // A first round starts the branch at the commit; so does a push that was begun and may have been made, so
      // the patch is never applied on top of itself.
      if (!state.pullRequest || again) await context.act('setBranch', { branch, sha: commit, force: true });
      return context.act('applyPatch', { branch, expectedHead: commit, patch, message });
    });
    const number =
      state.pullRequest?.number ??
      (await context.once(
        'pull request',
        async () =>
          // One opened before whose number was lost is found, not opened again.
          (await context.read('pullRequestFrom', { branch }))?.number ??
          (
            await context.act('openPullRequest', {
              head: branch,
              base: 'main',
              title,
              body: pullRequestBody(workItem, issue, spec),
              draft: true,
            })
          ).number,
      ));
    await context.keepSession(handback.session);
    const files = changedFiles(patch);
    return [
      {
        type: 'pull-request.pushed',
        actor: 'coder',
        summary: `${round > 1 ? `Round ${round}` : 'A fix'} pushed to PR #${number}`,
        payload: {
          number,
          title,
          branch,
          attempt: round,
          testsFirst: files.some((f) => isTest(f.path)),
          files: files.slice(0, 200),
        },
      },
    ];
  },
});

/** A fix's branch: the factory's prefix, the work item, and a few words of its ticket's title. */
export function branchFor(workItem: string, title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 5)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  return `factory/${workItem}${words ? `-${words}` : ''}`;
}

export const refersTo = (issue: number | null) => (issue ? `Refers to #${issue}.` : '');

function pullRequestBody(workItem: string, issue: number | null, spec: PayloadOf<'spec.written'>): string {
  return [
    `The factory’s fix for ticket #${workItem}. ${refersTo(issue)}`.trim(),
    '',
    spec.outcome,
    '',
    ...spec.criteria.map((c) => `- Given ${c.given}, when ${c.when}, then ${c.expect}.`),
  ].join('\n');
}

/** Whether a path is a test, by the conventions Vitest and Jest find tests by. */
const isTest = (path: string) =>
  /(^|\/)(test|tests|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);

/** Each file a patch changes, with the lines it adds and removes. */
function changedFiles(patch: string): { path: string; added: number; removed: number }[] {
  return filesIn(patch).map(({ path, patch: file }) => {
    const lines = file.hunks.flatMap((hunk) => hunk.lines);
    return {
      path: path.slice(0, 200),
      added: lines.filter((l) => l.startsWith('+')).length,
      removed: lines.filter((l) => l.startsWith('-')).length,
    };
  });
}
