/**
 * The planner: turns a ticket into a spec the coder can be held to, or says it cannot. It reads the app's repository
 * at the commit the fix will start from, and hands back the spec in the fixed template (`spec.written`): the outcome,
 * Given/When/Then criteria the coder can write as failing tests, the files that may change, risk tags and a rollout
 * note. Or it rejects the ticket, or asks Martin a question, and the work item holds for him.
 *
 * What it is told is the ticket's public view and what the senses saw, by their typed fields (`evidence.ts`): never
 * a visitor's words, and never a log message, which may carry them.
 *
 * It stops at a diagnosis: the code at fault, and why. Reproducing the defect (a server, requests, a script) is the
 * coder's, whose first step is a failing test. On Qwen, planners that reproduced it found the cause in a few minutes
 * and spent the rest of their 30 to 45 doing so.
 *
 * The planner has the checkout's tools, but nothing it changes leaves the sandbox: the line reads only its result,
 * and the coder's step starts from a fresh checkout. Its scope is held to the line's rules here, by the schema: a
 * plain path in the repository, never naming the workflows, the deployment, or a path the app's CODEOWNERS gives
 * Martin, as the repository has them at that commit. A fix that needs one is not the line's to make, and the planner
 * says so by rejecting the ticket. The line's fence holds the coder's patch to the same paths at its commit
 * (`coder.ts`), and the GitHub worker refuses every protected file a patch changes, as the last word.
 */
import type { PayloadOf } from '@software-factory/events';
import { RISKS } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { inScope, NEVER, pattern, plainPath } from '../../github/paths.ts';
import { count, defineAgent, holdDraft, words } from './agent.ts';
import { type Signal, seen, ticketLines } from './evidence.ts';

export interface PlannerInput {
  workItem: string;
  /** The ticket, as its public view has it. */
  ticket: PayloadOf<'ticket.opened'>;
  /** What each sense saw, in the order they saw it. A report's signal is not here. */
  signals: Signal[];
  /** The paths no scope may name at the commit: the workflows, the deployment and what CODEOWNERS gives a person. */
  protectedPaths: readonly string[];
  /** Martin's answers to the holds at Plan, each with what he was asked. */
  answers: { asked: string; answer: string }[];
  /** Why the planner's last attempt failed, such as a scope its schema refused, so it does not hand that back again. */
  failure?: string | null | undefined;
}

/**
 * Whether a scope entry takes in a protected path: names one, is a folder or pattern with one in it, or is a
 * protected folder's name without its slash. A protected folder stands for a file in it, and one that matches
 * anywhere (an entry with no leading slash in CODEOWNERS) for its name at the top.
 */
function touches(entry: string, protectedPaths: readonly string[]): boolean {
  if (inScope(entry, protectedPaths)) return true;
  const within = pattern(entry);
  return protectedPaths.some((path) => {
    const sample = path.replace(/^\*\*\//, '').replace(/\*/g, 'x');
    return sample.endsWith('/') ? within.test(`${sample}x`) || within.test(sample.slice(0, -1)) : within.test(sample);
  });
}

/** What is wrong with a scope entry, if anything: it must be a plain path in the repository, and keep out of the protected paths. */
function scopeProblem(entry: string, protectedPaths: readonly string[]): string | undefined {
  // A folder ends in its slash; the rest of it is a path like any other.
  if (!plainPath(entry.endsWith('/') ? entry.slice(0, -1) : entry))
    return `${entry} is not a plain path in the repository`;
  if (touches(entry, protectedPaths)) return `${entry} names a path no patch may change`;
  return undefined;
}

/** The spec, with a scope of plain paths that keeps out of the protected paths. */
const specWithin = (protectedPaths: readonly string[]) =>
  PAYLOADS['spec.written'].superRefine((spec, ctx) => {
    spec.scope.forEach((entry, i) => {
      const problem = scopeProblem(entry, protectedPaths);
      if (problem) ctx.addIssue({ code: 'custom', path: ['scope', i], message: problem });
    });
  });

/**
 * The planner's result, with its scope held to the protected paths given; with none, to the rules of the line that
 * hold whatever the repository's CODEOWNERS says.
 */
export const plannerResult = (protectedPaths: readonly string[] = NEVER) =>
  z.discriminatedUnion('verdict', [
    z.strictObject({ verdict: z.literal('spec'), spec: specWithin(protectedPaths) }),
    /** The ticket cannot be made testable, is not a defect in the app, or needs a fix the line may not make. */
    z.strictObject({ verdict: z.literal('reject'), reason: words(300) }),
    /** Something about what the shop should do that only Martin can say. */
    z.strictObject({ verdict: z.literal('question'), question: words(300) }),
  ]);

export type PlannerResult = z.infer<ReturnType<typeof plannerResult>>;

/** What each risk tag says of a fix, so the planner tags what the fix does, not what the defect did. */
const RISK_MEANINGS: Record<(typeof RISKS)[number], string> = {
  'test-loosening': 'it changes or removes an assertion an existing test makes',
  'dependency-change': 'it adds, removes or updates a dependency',
  'security-headers': 'it changes the headers the app sends',
  'out-of-scope': 'it changes behaviour beyond what the ticket is about',
};

const SPEC_TEMPLATE = [
  '- `outcome`: one sentence, what is true once the fix is in.',
  '- `criteria`: one to twelve acceptance criteria, each an object of `given`, `when` and `expect` (the then), in a sentence each. A criterion says what a visitor or a caller of the code sees, not how the code changes. Each is a test the coder can write with the repository’s own tests: it fails at this commit and passes once the fix is in.',
  '- `scope`: the files the coder may change, its tests among them, and no more than the fix needs: a path from the top of the repository, a folder ending in `/`, or a pattern with `*`.',
  `- \`risks\`: a list of tags, each exactly one of these words, for what the fix itself does; usually it is empty. ${RISKS.map((r) => `${r}: ${RISK_MEANINGS[r]}`).join('; ')}.`,
  '- `rollout`: a sentence or two on how the fix ships and what would show it worked.',
  'Every string is a plain sentence or a path, at most 200 characters (the rollout 300).',
];

export const planner = defineAgent<PlannerInput, PlannerResult>({
  agent: 'planner',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  input: async ({ workItem, state, commit, failure, ticket, signals, read }) => ({
    workItem,
    ticket: await ticket(),
    signals: await signals(),
    protectedPaths: await read('protectedPaths', { ref: commit }),
    answers: state.answers,
    failure,
  }),
  schema: ({ protectedPaths }) => plannerResult(protectedPaths),
  prompt: ({ workItem, ticket, signals, protectedPaths, answers, failure }) =>
    [
      `Plan the fix for ticket #${workItem}: ${ticket.title}.`,
      ...ticketLines(ticket),
      ...(signals.length ? ['', 'What the senses saw:', ...signals.flatMap(seen)] : []),
      ...(answers.length
        ? ['', 'Martin was asked, and answered:', ...answers.map((a) => `- ${a.asked} He said: ${a.answer}`)]
        : []),
      ...(failure ? ['', `Your last attempt at this plan failed: ${failure}. Do not hand back the same again.`] : []),
      '',
      'Find the cause in the repository: start from the route, and read the code that serves it and its tests. Stop as soon as you can name the code at fault and say why it does what the evidence shows: that diagnosis is all the plan needs, and most plans need a dozen tool calls or fewer.',
      'Do not reproduce the defect: start no server, send no requests, write no scripts, and run no tests. The coder’s first step is a failing test that reproduces it, and your criteria say what that test shows. You plan; the coder fixes. Change nothing: no change of yours leaves this checkout.',
      '',
      'Then write the result, one of three:',
      '1. {"verdict":"spec","spec":{"outcome","criteria":[{"given","when","expect"}],"scope":[],"risks":[],"rollout"}}, the spec the coder will be held to:',
      ...SPEC_TEMPLATE.map((line) => `   ${line}`),
      `2. {"verdict":"reject","reason"} when you cannot make it testable: the cause is not in this repository, or you cannot find the defect the evidence shows, or no test could tell the fix from the defect. Reject it too when the fix needs a path no scope may name: ${protectedPaths.join(', ')}. The reason is one or two short sentences for Martin, at most 300 characters, naming the file or what is missing.`,
      '3. {"verdict":"question","question"} when the fix turns on what the shop should do, which only Martin can say: one question he can answer in a line, at most 300 characters.',
    ].join('\n'),
  apply: async (planned) => {
    switch (planned.verdict) {
      case 'spec': {
        const { spec } = planned;
        const summary = `Spec written: ${count(spec.criteria.length, 'criterion', 'criteria')}, ${count(spec.scope.length, 'path')} in scope`;
        return [{ type: 'spec.written', actor: 'planner', summary, payload: spec }];
      }
      case 'reject':
        return [
          holdDraft('planner', { stage: 'plan', kind: 'held', cause: 'ticket-rejected', reason: planned.reason }),
        ];
      case 'question':
        return [
          holdDraft('planner', {
            stage: 'plan',
            kind: 'question',
            cause: 'question',
            reason: 'The planner needs an answer to write the spec',
            question: planned.question,
          }),
        ];
    }
  },
});
