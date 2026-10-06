/**
 * The coder: reads the spec, the ticket's evidence and the app's `AGENTS.md`, writes a test that fails because of the
 * defect, then the fix, inside the spec's scope, and hands back the patch. Its result is the pull request's title and
 * the commit's note: what was wrong, which test shows it, and what changed.
 *
 * It applies no coding standards or design rules beyond the repository's invariants in `AGENTS.md`: the reviewer
 * holds it to those, so they do not compete with the work for its context. Nor does it fix what else it notices: the
 * shop is bad on purpose, and a fix that mends other defects in passing would muddle what the ticket's fix did.
 *
 * The scope is a fence, not a request: the line refuses a patch that changes a file outside it, or a path no patch may
 * change (the workflows, the deployment, and what the app's CODEOWNERS gives a person at the step's commit), whole,
 * before it reaches GitHub. The refusal is recorded with the fence's output (`action.refused`), and the next step
 * comes back here with it; the checkout is fresh, since nothing of a refused patch is kept. A later round, sent back
 * by the gates or the reviewer, starts from the pull request's head. Either way the coder resumes its own session
 * when it has one, which holds the spec and what it tried; without one, it is told everything a first step is. This
 * module decides both, from its input alone (`resume`, `prompt`), so the line and the bench agree.
 */
import type { PayloadOf, Stage } from '@software-factory/events';
import { z } from 'zod';
import { filesIn, PatchRefused } from '../../github/patches.ts';
import { GitHubWorkerError } from '../../github/worker-client.ts';
import { type Fenced, fence } from '../../runners/scope.ts';
import { answerOf, defineAgent, need, StepFailed, StepStale, words } from './agent.ts';
import { type Signal, seen, ticketLines } from './evidence.ts';

export interface CoderInput {
  workItem: string;
  /** The ticket, as its public view has it. */
  ticket: PayloadOf<'ticket.opened'>;
  /** What each sense saw, in the order they saw it. A report's signal is not here. */
  signals: Signal[];
  spec: PayloadOf<'spec.written'>;
  /** The paths no patch may change at the step's commit: the workflows, the deployment and what CODEOWNERS gives a person. */
  protectedPaths: readonly string[];
  round: number;
  /** The session the coder's last step ended with, which a later step carries on. */
  session?: string | null | undefined;
  /** What sent the work back, for a later round. */
  returned?: { from: Stage; reason: string } | undefined;
  /** The scope fence's output on the coder's last patch, which it refused. */
  fenced?: string | undefined;
  /** Martin's answer to the hold before this step, if he wrote one. */
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
  /** The commit's body: what was wrong, which test shows it, what changed, and anything noticed and left alone. */
  note: words(1000),
});

export type CoderResult = z.infer<typeof coderResult>;

/** Whether a step comes after another of this round's or an earlier one's: the work came back, or the fence refused it. */
const later = (input: CoderInput) => input.fenced !== undefined || input.round > 1;

/** The session a step carries on: a later step's, when the coder has one. */
const resumed = (input: CoderInput) => (later(input) ? (input.session ?? undefined) : undefined);

/** The fence on the coder's patch: the spec's scope, and never a protected path. */
export const fenceFor = (patch: string, { spec, protectedPaths }: CoderInput): Fenced =>
  fence(patch, spec.scope, protectedPaths);

/**
 * The coder's input for the step a refusal sends the work back to: the fence's output, and the session the refused
 * step ended with. The line builds its next step from the refusal's event the same way.
 */
export const coderInputAfterRefusal = (input: CoderInput, output: string, session: string | null): CoderInput => ({
  ...input,
  fenced: output,
  session,
});

const RESULT = [
  'Then write the result, {"title","note"}:',
  '- `title`: the pull request’s title as a Conventional Commit, at most 80 characters, such as "fix(cart): count the last item".',
  '- `note`: the commit’s body, at most 1000 characters, in plain sentences for the reviewer: what was wrong, which test shows it, and what you changed. Add anything else you noticed and left alone.',
];

function specLines({ spec }: CoderInput): string[] {
  return [
    `Outcome: ${spec.outcome}`,
    'Acceptance criteria:',
    ...spec.criteria.map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.expect}.`),
    `Scope, the only files you may change: ${spec.scope.join(', ')}. A folder ending in / takes in every file under it; * stands for any name within one folder, and ** for any depth of folders.`,
    ...(spec.risks.length ? [`The planner tagged its risks: ${spec.risks.join(', ')}.`] : []),
  ];
}

function first(input: CoderInput): string[] {
  const { workItem, ticket, signals, answer } = input;
  return [
    `Fix ticket #${workItem}: ${ticket.title}.`,
    ...ticketLines(ticket),
    ...(signals.length ? ['', 'What the senses saw:', ...signals.flatMap(seen)] : []),
    '',
    'The spec you are held to:',
    ...specLines(input),
    ...(answer ? ['', `Martin answered: ${answer}`] : []),
    '',
    'Read AGENTS.md first: its rules hold for every change here. Then:',
    '1. Find the cause. Start from the code the criteria name, and its tests.',
    '2. Write the test first: a test for each criterion, in a test file the scope allows, beside the tests that are there. Run it and see it fail because of the defect.',
    '3. Fix the code, and run the tests again until yours pass and none that passed before fails.',
    '',
    'Change only what the criteria need. The shop is bad on purpose, so you may see other things wrong: leave them, even in a file the scope allows, and mention them in your note. The line refuses a patch that changes any file outside the scope, whole. Leave your changes in the checkout: the line takes them from there.',
    '',
    ...RESULT,
  ];
}

/** A later step: why it came back, from review or the gates, from the fence, or both. */
function again(input: CoderInput): string[] {
  const { workItem, round, returned, fenced, answer } = input;
  const back =
    round > 1
      ? [
          `Your change for ticket #${workItem} came back from ${returned?.from ?? 'review'}, for round ${round}: ${returned?.reason ?? 'it needs another look'}.`,
          'The checkout is the pull request’s head, with the change you pushed before in it.',
        ]
      : [];
  const refused = fenced
    ? [
        `The line refused your patch${round > 1 ? ' for this round' : ''}: it changed files outside the spec’s scope. The scope fence printed:`,
        ...fenced.split('\n').map((line) => `    ${line}`),
        `Nothing of that patch was kept: the checkout is back where ${round > 1 ? 'this round' : 'you'} started. Make the fix again, changing only files the scope allows. A test that will not fit in a test file the scope allows is one to leave out; say so in your note.`,
      ]
    : ['Put it right inside the same scope, and run the tests again.'];
  const why = [...back, ...refused];
  // Without its session, the coder needs everything a first step is told.
  if (!resumed(input)) return [...why, '', ...first(input)];
  // The spec again, since the planner may have written it afresh since the session began.
  return [
    ...why,
    '',
    'The spec you are held to:',
    ...specLines(input),
    ...(answer ? ['', `Martin answered: ${answer}`] : []),
    '',
    'Then write the result again, {"title","note"}: the note says what the whole change does, not only this round.',
  ];
}

export const coder = defineAgent<CoderInput, CoderResult>({
  agent: 'coder',
  maxTurns: 50,
  deadlineSeconds: 30 * 60,
  input: async ({ workItem, state, round, commit, session, ticket, signals, read }) => ({
    workItem,
    ticket: await ticket(),
    signals: await signals(),
    spec: need(state.spec, 'a spec'),
    protectedPaths: await read('protectedPaths', { ref: commit }),
    round,
    session,
    returned: state.rebuild,
    fenced: state.fenced,
    answer: answerOf(state),
  }),
  resume: resumed,
  schema: () => coderResult,
  prompt: (input) => (later(input) ? again(input) : first(input)).join('\n'),
  apply: async ({ title, note }, handback, input, context) => {
    const { spec, round } = input;
    const { workItem, issue, state, commit } = context;
    const { patch } = handback;
    if (!patch) throw new StepFailed('The coder handed back no change');
    const fenced = refusing(() => fenceFor(patch, input));
    if (!fenced.ok) {
      // Nothing reaches GitHub. The session is kept, so the step the refusal sends the work back to resumes it.
      await context.keepSession(handback.session);
      const to = state.pullRequest ? `pull request #${state.pullRequest.number}` : 'a new pull request';
      return [
        {
          type: 'action.refused',
          actor: 'factory',
          summary: `The scope fence refused the coder’s patch: ${fenced.outside.join(', ')}`.slice(0, 200),
          payload: {
            mechanism: 'scope-fence',
            action: `Push the coder’s round ${round} to ${to}`,
            output: fenced.output,
          },
        },
      ];
    }
    const branch = state.pullRequest?.branch ?? branchFor(workItem, need(state.ticket, 'a ticket').title);
    const message = `${title}\n\n${note}`.slice(0, 9_000);
    await context.once('push', async (again) => {
      // A first round starts the branch at the commit; so does a push that was begun and may have been made, so
      // the patch is never applied on top of itself.
      if (!state.pullRequest || again) await context.act('setBranch', { branch, sha: commit, force: true });
      return context.act('applyPatch', { branch, expectedHead: commit, patch, message }).catch((error: unknown) => {
        throw judged(error);
      });
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
    const files = refusing(() => changedFiles(patch));
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

/** A patch the factory cannot read is the coder's failure. */
function refusing<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    if (error instanceof PatchRefused) throw new StepFailed(`The coder's change cannot be applied: ${error.message}`);
    throw error;
  }
}

/**
 * What GitHub refusing the push means. A patch it will not apply is the coder's failure; a branch that moved while
 * the coder worked (Martin's push, or main merged in) makes the step start again from the branch as it is.
 * Anything else is GitHub's, and the push is tried again.
 */
function judged(error: unknown): unknown {
  if (!(error instanceof GitHubWorkerError)) return error;
  if (error.kind === 'patch-refused')
    return new StepFailed(`GitHub would not take the coder's change: ${error.message}`);
  if (error.status === 409) return new StepStale(`The branch moved while the coder worked: ${error.message}`);
  return error;
}

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

/**
 * A fix's pull request until the describer writes its description: the ticket's issue and the spec the fix is held
 * to. It stays a draft until then, so nobody reviews it before the gates and the reviewer have.
 */
function pullRequestBody(workItem: string, issue: number | null, spec: PayloadOf<'spec.written'>): string {
  return [
    `The factory’s fix for ticket #${workItem}. ${refersTo(issue)}`.trim(),
    '',
    `**Outcome.** ${spec.outcome}`,
    '',
    '**Acceptance criteria**',
    '',
    ...spec.criteria.map((c) => `- Given ${c.given}, when ${c.when}, then ${c.expect}.`),
    '',
    `**Scope.** ${spec.scope.map((path) => `\`${path}\``).join(', ')}`,
    '',
    `**Risks.** ${spec.risks.length ? spec.risks.join(', ') : 'none tagged'}`,
    '',
    `**Rollout.** ${spec.rollout}`,
    '',
    '_A draft until its gates and review have passed and the factory has written its description._',
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
