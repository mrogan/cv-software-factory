/**
 * The planner: turns a ticket into a spec the coder can be held to, or says it cannot. It reads the ticket's typed
 * fields and the app's repository, read-only, and hands back the spec in the fixed template (`spec.written`), or a
 * rejection, or a question for Martin.
 *
 * The prompt here is the least that does the job; milestone 5's task 10 writes the planner properly.
 */
import type { PayloadOf } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { z } from 'zod';
import { inScope, NEVER } from '../../github/paths.ts';
import { answerOf, count, defineAgent, holdDraft, need, type Signal, words } from './agent.ts';

export interface PlannerInput {
  workItem: string;
  ticket: PayloadOf<'ticket.opened'>;
  /** What each sense saw, by its typed fields. A report's text is not here. */
  signals: Signal[];
  /** Martin's answer to the hold before this step, if there was one. */
  answer?: string | undefined;
}

const spec = PAYLOADS['spec.written'].refine(
  (s) => s.scope.every((entry) => !inScope(entry, NEVER) && !NEVER.some((never) => entry.startsWith(never))),
  { message: 'a scope never names the workflows or the deployment', path: ['scope'] },
);

export const plannerResult = z.discriminatedUnion('verdict', [
  z.strictObject({ verdict: z.literal('spec'), spec }),
  /** The ticket cannot be made testable, or is not a defect in the app. */
  z.strictObject({ verdict: z.literal('reject'), reason: words(300) }),
  /** Something only Martin can say. */
  z.strictObject({ verdict: z.literal('question'), question: words(300) }),
]);

export type PlannerResult = z.infer<typeof plannerResult>;

export const planner = defineAgent<PlannerInput, PlannerResult>({
  agent: 'planner',
  maxTurns: 30,
  deadlineSeconds: 15 * 60,
  input: async ({ workItem, state, signals }) => ({
    workItem,
    ticket: need(state.ticket, 'a ticket'),
    signals: await signals(),
    answer: answerOf(state),
  }),
  schema: () => plannerResult,
  prompt: ({ workItem, ticket, signals, answer }) => {
    const fingerprint =
      'class' in ticket.fingerprint
        ? `${ticket.fingerprint.class} on ${ticket.fingerprint.route}`
        : `wrong text on ${ticket.fingerprint.page}`;
    const seen = signals.map((s) => `- ${s.sense}: ${s.check} on ${s.route}${s.symptom ? ` (${s.symptom})` : ''}`);
    return [
      `Ticket #${workItem}: ${ticket.title}.`,
      `Category ${ticket.category}, severity ${ticket.severity}, fingerprint ${fingerprint}.`,
      ...(seen.length ? ['What the senses saw:', ...seen] : []),
      ...(answer ? [`Martin answered: ${answer}`] : []),
      '',
      'Read the repository and find the cause. Change nothing.',
      'Write a spec for the fix: the outcome, Given/When/Then acceptance criteria (`given`, `when`, `expect`), the files that may change (`scope`), risk tags from test-loosening, dependency-change, security-headers and out-of-scope, and a rollout note.',
      'The result is {"verdict":"spec","spec":{"outcome","criteria","scope","risks","rollout"}}; or {"verdict":"reject","reason"} if it cannot be made testable; or {"verdict":"question","question"} if only Martin can settle it.',
    ].join('\n');
  },
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
