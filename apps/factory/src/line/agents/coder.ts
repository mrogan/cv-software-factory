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
 * by the gates or the reviewer, starts from the pull request's head, with the review's blocking findings and its
 * suggestions when it was the reviewer that sent it. Either way the coder resumes its own session when it has one,
 * which holds the spec and what it tried; without one, it is told everything a first step is. This module decides
 * both, from its input alone (`resume`, `prompt`), so the line and the bench agree.
 *
 * Suggestions do not block, and the coder answers them as the factory asks of any agent answering a review: it takes
 * each, changing the code for it, or declines it with a reason (`declined`). The GitHub worker answers each declined
 * suggestion's thread with the reason and resolves it once the change is pushed; one taken is the next reviewer's to
 * find taken, and its thread is resolved then. An approval that leaves suggestions sends the work back for them alone
 * (`machine.ts`): a coder that declines them all changes nothing, and says only what it declined.
 *
 * Changing nothing can be the right answer: a gate that fails on a defect the change uncovered and did not cause, a
 * finding the change already meets, or code that already does what the spec asks. The coder then says so, and why,
 * instead of handing back a change (`{"unchanged"}`), and the work item holds for Martin with its reason
 * (`unchangedHold`). A step that hands back no change and says nothing of why has failed.
 */
import { MAX_FINDINGS, type PayloadOf, type Stage } from '@software-factory/events';
import { z } from 'zod';
import { filesIn, PatchRefused } from '../../github/patches.ts';
import { GitHubWorkerError } from '../../github/worker-client.ts';
import { type Fenced, fence } from '../../runners/scope.ts';
import type { Draft } from '../gates.ts';
import { unchangedHold, type WorkItemState } from '../machine.ts';
import { answerThreads, cites, type Finding, lineage, threadAnswers } from '../review.ts';
import {
  answerOf,
  commitTitle,
  defineAgent,
  type EffectsContext,
  holdDraft,
  need,
  StepFailed,
  StepStale,
  words,
} from './agent.ts';
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
  /** The review's blocking findings, when review sent the work back. */
  findings?: Finding[] | undefined;
  /** The review's suggestions, when review sent the work back and the coder has not yet answered them. */
  suggestions?: Finding[] | undefined;
  /** The scope fence's output on the coder's last patch, which it refused. */
  fenced?: string | undefined;
  /** Martin's answer to the hold before this step, if he wrote one. */
  answer?: string | undefined;
}

/** The most a coder may say of why it changed nothing: it is the hold's reason, after the line's own words. */
export const UNCHANGED_MAX = 200;

/** The suggestions the coder declines, each by its number as it was given them, with its reason. */
const declined = z
  .array(z.strictObject({ suggestion: z.number().int().min(1).max(MAX_FINDINGS), reason: words(300) }))
  .max(MAX_FINDINGS);

/**
 * The result, for a round given `suggestions` suggestions: a declined one must be one of them. A round sent back for
 * suggestions alone (`alone`) may change nothing by declining every one.
 */
export function coderResult(suggestions = 0, alone = false) {
  return z
    .union([
      z.strictObject({
        /** The pull request's title, and its commit's headline, as a Conventional Commit. */
        title: commitTitle,
        /** The commit's body: what was wrong, which test shows it, what changed, and anything noticed and left alone. */
        note: words(1000),
        /** The suggestions it declined, with why; every other it took. */
        declined: declined.optional(),
      }),
      z.strictObject({
        /** Why the coder changed nothing, for Martin. */
        unchanged: words(UNCHANGED_MAX),
      }),
      /** Every suggestion declined, and nothing changed. */
      z.strictObject({ declined }),
    ])
    .superRefine((result, ctx) => {
      // The change is approved: the round is for its suggestions, and declining every one is how it changes nothing.
      if (alone && 'unchanged' in result) {
        const message = 'a round for suggestions alone changes nothing by declining every one';
        ctx.addIssue({ code: 'custom', path: ['unchanged'], message });
      }
      if (!('declined' in result) || !result.declined) return;
      result.declined.forEach(({ suggestion }, i) => {
        const path = ['declined', i, 'suggestion'];
        if (suggestion > suggestions) {
          const message = suggestions
            ? `there are ${suggestions} suggestions, not ${suggestion}`
            : 'there are no suggestions';
          ctx.addIssue({ code: 'custom', path, message });
        } else if (result.declined?.findIndex((d) => d.suggestion === suggestion) !== i) {
          ctx.addIssue({ code: 'custom', path, message: `suggestion ${suggestion} is declined twice` });
        }
      });
      if ('title' in result) return;
      if (!alone) {
        const message = 'only a round sent back for suggestions alone may change nothing by declining them';
        ctx.addIssue({ code: 'custom', path: ['declined'], message });
      } else if (result.declined.length < suggestions) {
        const message = 'a round that changes nothing declines every suggestion';
        ctx.addIssue({ code: 'custom', path: ['declined'], message });
      }
    });
}

export type CoderResult = z.infer<ReturnType<typeof coderResult>>;

/** Whether the work came back for an approving review's suggestions alone, with nothing blocking. */
const suggestionsAlone = ({ findings, suggestions }: CoderInput) => !findings?.length && Boolean(suggestions?.length);

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
  `If the code already does what every criterion asks, so there is nothing to fix, change nothing and write {"unchanged"} instead: at most ${UNCHANGED_MAX} characters, in plain sentences for Martin, on what you found. He decides what happens next.`,
];

/** How a round with suggestions answers them. */
const DECLINING =
  '- `declined`: the suggestions you decline, each {"suggestion","reason"}: its number above, and why, in at most 300 characters, for the reviewer and the pull request’s thread. Every suggestion you leave out is one you took. Leave it out when you take them all.';

/** When a round sent back for suggestions alone may change nothing, and how it says so. */
const DECLINE_ALL =
  'If you decline every suggestion, change nothing: leave the checkout as it is and write only {"declined"}, with each of them.';

/** When a later round may change nothing, and how it says so. */
const UNCHANGED = `Change nothing only if what sent the work back is not your change’s doing (a check fails on a defect your change uncovered and did not cause), or your change already does what is asked. Then leave the checkout as it is and write {"unchanged"} instead: at most ${UNCHANGED_MAX} characters, in plain sentences for Martin, on why. He decides what happens next.`;

function specLines({ spec }: CoderInput): string[] {
  return [
    `Outcome: ${spec.outcome}`,
    'Acceptance criteria:',
    ...spec.criteria.map((c, i) => `${i + 1}. Given ${c.given}, when ${c.when}, then ${c.expect}.`),
    `Scope, the only files you may change: ${spec.scope.join(', ')}. A folder ending in / takes in every file under it; * stands for any name within one folder, and ** for any depth of folders.`,
    ...(spec.risks.length ? [`The planner tagged its risks: ${spec.risks.join(', ')}.`] : []),
  ];
}

/** The ticket, what the senses saw, the spec and Martin's answer: what a step without its session is told first. */
function briefing(input: CoderInput): string[] {
  const { workItem, ticket, signals, answer } = input;
  return [
    `Fix ticket #${workItem}: ${ticket.title}.`,
    ...ticketLines(ticket, signals),
    ...(signals.length ? ['', 'What the senses saw:', ...signals.flatMap(seen)] : []),
    '',
    'The spec you are held to:',
    ...specLines(input),
    ...(answer ? ['', `Martin answered: ${answer}`] : []),
  ];
}

function first(input: CoderInput): string[] {
  return [
    ...briefing(input),
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
  const { workItem, round, returned, findings, suggestions, fenced, answer } = input;
  const back =
    round > 1
      ? [
          `Your change for ticket #${workItem} came back from ${returned?.from ?? 'review'}, for round ${round}: ${returned?.reason ?? 'it needs another look'}.`,
          ...(findings?.length
            ? [
                'The reviewer’s blocking findings, each at a line of your change, with the rule or criterion it cites:',
                ...findings.map((f) => `- ${f.path}:${f.line}${cites(f) ? ` (${cites(f)})` : ''}: ${f.comment}`),
              ]
            : []),
          ...(suggestions?.length
            ? [
                'The reviewer’s suggestions, which do not block. Take each, changing the code for it inside the scope, or decline it with a reason:',
                ...suggestions.map(
                  (f, i) => `${i + 1}. ${f.path}:${f.line}${cites(f) ? ` (${cites(f)})` : ''}: ${f.comment}`,
                ),
              ]
            : []),
          'The checkout is the pull request’s head, with the change you pushed before in it.',
        ]
      : [];
  const refused = fenced
    ? [
        `The line refused your patch${round > 1 ? ' for this round' : ''}: it changed files outside the spec’s scope. The scope fence printed:`,
        ...fenced.split('\n').map((line) => `    ${line}`),
        `Nothing of that patch was kept: the checkout is back where ${round > 1 ? 'this round' : 'you'} started. Make the fix again, changing only files the scope allows. A test that will not fit in a test file the scope allows is one to leave out; say so in your note.`,
      ]
    : suggestionsAlone(input)
      ? ['Take what you take inside the same scope, and run the tests again.', DECLINE_ALL]
      : ['Put it right inside the same scope, and run the tests again.', ...(round > 1 ? [UNCHANGED] : [])];
  const why = [...back, ...refused];
  const declining = suggestions?.length ? [DECLINING] : [];
  // Without its session, a round for suggestions alone is told the work, and that the fix is in and approved.
  if (!resumed(input) && suggestionsAlone(input)) {
    return [
      ...why,
      '',
      ...briefing(input),
      '',
      'Read AGENTS.md first: its rules hold for every change here. The fix is in the checkout, and the reviewer approved it: change only what a suggestion you take needs.',
      '',
      'Then write the result, {"title","note","declined"}:',
      ...RESULT.slice(1, 3),
      ...declining,
    ];
  }
  // Without its session, the coder needs everything a first step is told.
  if (!resumed(input)) return [...why, '', ...first(input), ...declining];
  // The spec again, since the planner may have written it afresh since the session began.
  return [
    ...why,
    '',
    'The spec you are held to:',
    ...specLines(input),
    ...(answer ? ['', `Martin answered: ${answer}`] : []),
    '',
    `Then write the result again, {"title","note"${suggestions?.length ? ',"declined"' : ''}}: the note says what the whole change does, not only this round.`,
    ...declining,
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
    findings: state.rebuild?.from === 'review' ? state.review?.findings.filter((f) => f.blocking) : undefined,
    suggestions: suggestionsFor(state),
    fenced: state.fenced,
    answer: answerOf(state),
  }),
  resume: resumed,
  schema: (input) => coderResult(input.suggestions?.length ?? 0, suggestionsAlone(input)),
  prompt: (input) => (later(input) ? again(input) : first(input)).join('\n'),
  apply: async (result, handback, input, context) => {
    const { spec, round, suggestions = [] } = input;
    const { workItem, issue, state, commit } = context;
    const { patch } = handback;
    if ('unchanged' in result) {
      if (patch) throw new StepFailed('The coder said it changed nothing, but handed back a change');
      // Its next round, after Martin's answer, resumes the session that found nothing to change.
      await context.keepSession(handback.session);
      return [holdDraft('coder', unchangedHold(state, result.unchanged))];
    }
    if (!('title' in result)) {
      if (patch) throw new StepFailed('The coder declined every suggestion, but handed back a change');
      const pullRequest = need(state.pullRequest, 'a pull request').number;
      await context.keepSession(handback.session);
      await answerDeclined(context, pullRequest, suggestions, result.declined);
      return [answeredDraft(pullRequest, suggestions, result.declined)];
    }
    const { title, note, declined = [] } = result;
    if (!patch) throw new StepFailed('The coder handed back no change, and did not say why');
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
            files: fenced.files.slice(0, 200),
          },
        },
      ];
    }
    const branch = state.pullRequest?.branch ?? branchFor(workItem, need(state.ticket, 'a ticket').title);
    const message = `${title}\n\n${note}`.slice(0, 9_000);
    const head = await context.once('push', async (again) => {
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
    await answerDeclined(context, number, suggestions, declined);
    const files = refusing(() => changedFiles(patch));
    // What a merge would bring in, every round together: GitHub's comparison of the new head with main.
    const compared = await context.read('comparison', { base: 'main', head });
    const whole = compared.files.map(({ path, added, removed }) => ({ path, added, removed }));
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
          whole: whole.slice(0, 200),
        },
      },
      ...(suggestions.length ? [answeredDraft(number, suggestions, declined)] : []),
    ];
  },
});

/**
 * The suggestions a round answers: the review's that sent the work back, which do not block, until the coder has
 * answered them once. One declined is not asked again; one taken is the next review's to find.
 */
function suggestionsFor(state: WorkItemState): Finding[] | undefined {
  if (state.rebuild?.from !== 'review' || state.suggestionsAnswered) return undefined;
  const suggestions = state.review?.findings.filter((f) => !f.blocking);
  return suggestions?.length ? suggestions : undefined;
}

type Declined = PayloadOf<'suggestions.answered'>['declined'];

/** Answers each declined suggestion's thread with the coder's reason, and resolves it. */
async function answerDeclined(
  context: EffectsContext,
  pullRequest: number,
  suggestions: Finding[],
  declined: Declined,
) {
  const answers = declined.flatMap(({ suggestion, reason }) => {
    const finding = suggestions[suggestion - 1];
    const reply = `Declined by the factory’s coder: ${reason}`;
    return finding ? lineage(context.state.reviews, finding).map((f) => ({ finding: f, reply })) : [];
  });
  await answerThreads(context, 'declined', pullRequest, threadAnswers(answers));
}

/** The coder's answer to its round's suggestions, as the line records it. */
function answeredDraft(pullRequest: number, suggestions: Finding[], declined: Declined): Draft {
  const taken = suggestions.length - declined.length;
  return {
    type: 'suggestions.answered',
    actor: 'coder',
    summary: `The coder took ${taken} of ${suggestions.length} suggestions on PR #${pullRequest}, and declined ${declined.length}`,
    payload: { pullRequest, suggestions: suggestions.length, declined },
  };
}

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
