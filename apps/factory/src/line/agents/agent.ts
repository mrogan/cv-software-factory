/**
 * What the line knows of each agent: one module per agent, holding what its step is given, its prompt, the skill it
 * names, its bounds, the schema of the result it hands back, and what that result does. The line runs every agent
 * the same way (`../worker.ts`), through `defineAgent`; everything that makes one agent unlike another is in its
 * module.
 *
 * A prompt is built from typed fields only: a ticket's category and fingerprint, a spec, a pull request's number,
 * Martin's answer to a hold. Never from a visitor's words, which reach no generative agent.
 *
 * What a result does in GitHub goes through `EffectsContext.once`, so the line can try a handback's effects again,
 * after GitHub or the store failed part-way, without running the agent again and without doing a write twice.
 */
import type { NewEvent, PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import type { ActionArgs, ActionName, ActionResult, ReadArgs, ReadName, ReadResult } from '../../github/server.ts';
import type { Handback } from '../../runners/steps.ts';
import type { Draft } from '../gates.ts';
import type { LineAgent, WorkItemState } from '../machine.ts';

/** A step that went wrong in a way the line counts against it: no handback, a result refused, an action refused. */
export class StepFailed extends Error {
  override name = 'StepFailed';
}

/** What a sense saw, by its typed fields only. */
export interface Signal {
  sense: string;
  check: string;
  route: string;
  symptom?: string | undefined;
}

/** What an agent's step may know of its work item as it starts. */
export interface StepContext {
  workItem: string;
  /** The ticket's issue in the app's repository. */
  issue: number | null;
  /** The agent's round: 1, and one more each time work returns to Build. */
  round: number;
  state: WorkItemState;
  /** The commit the step starts from: main's head before a pull request, and its head after. */
  commit: string;
  /** The commit a pull request's diff is taken against: its base, or the start before there is one. */
  base: string;
  /** The session the agent's last step ended with, which a later round may carry on. */
  session: string | null;
  /** What each sense saw of the work item. */
  signals(): Promise<Signal[]>;
}

/** What an agent's result may do: read and act in GitHub, each write at most once, and keep its session. */
export interface EffectsContext extends StepContext {
  /**
   * Does `write` once for this handback. A write already done gives back what it gave then. One begun and never
   * recorded (the line crashed, or the store failed, in between) runs again with `again` set, so it can make sure
   * doing it twice does no harm.
   */
  once<T>(name: string, write: (again: boolean) => Promise<T>): Promise<T>;
  act<K extends ActionName>(action: K, args: ActionArgs[K]): Promise<ActionResult<K>>;
  read<K extends ReadName>(read: K, args: ReadArgs[K]): Promise<ReadResult<K>>;
  /** Keeps the agent's session, for its next round to resume. */
  keepSession(session: string | null): Promise<void>;
}

export interface AgentDefinition<Input, Result> {
  agent: LineAgent;
  /** The skill the prompt names, which the runner tells the agent to use. */
  skill?: string;
  /** Turns, and seconds of work, before the step ends unfinished. */
  maxTurns: number;
  deadlineSeconds: number;
  /** What the step is given, from its work item. Throws `StepFailed` when the work item lacks something it needs. */
  input(context: StepContext): Input | Promise<Input>;
  prompt(input: Input): string;
  /** The session the step carries on, if it resumes one. */
  resume?(input: Input, context: StepContext): string | undefined;
  /**
   * The result the agent writes beside its changes, read through this schema. A result that is missing or that the
   * schema refuses makes a failed step.
   */
  schema(input: Input): z.ZodType<Result>;
  /** What the result does, in GitHub and as the events the line appends. Throws `StepFailed` for what is the step's fault. */
  apply(result: Result, handback: Handback, input: Input, context: EffectsContext): Promise<Draft[]>;
}

/** An agent as the line runs it, whatever its input and result. */
export interface Agent {
  agent: LineAgent;
  skill?: string;
  maxTurns: number;
  deadlineSeconds: number;
  /** Begins a step: what the agent is asked, and what to make of what it hands back. */
  start(context: StepContext): Promise<Started>;
}

export interface Started {
  prompt: string;
  resume: string | undefined;
  /** Reads the handback's result through the agent's schema, and does what it says. */
  finish(handback: Handback, context: EffectsContext): Promise<Draft[]>;
}

/** An agent's definition, made into one the line can run, keeping its own types for those who use it directly. */
export function defineAgent<Input, Result>(
  definition: AgentDefinition<Input, Result>,
): AgentDefinition<Input, Result> & Agent {
  const { agent } = definition;
  return {
    ...definition,
    async start(context) {
      const input = await definition.input(context);
      return {
        prompt: definition.prompt(input),
        resume: definition.resume?.(input, context),
        async finish(handback, effects) {
          const parsed = definition.schema(input).safeParse(handback.result);
          if (!parsed.success) {
            const problems = parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.') || 'result'}: ${i.message}`);
            throw new StepFailed(
              handback.result === undefined
                ? `The ${agent} handed back no result${handback.error ? ` (${handback.error})` : ''}`
                : `The ${agent}'s result does not fit its schema (${problems.join('; ')})`,
            );
          }
          return definition.apply(parsed.data, handback, input, effects);
        },
      };
    },
  };
}

/** Text a person reads, as the events take it: trimmed, and not empty. */
export const words = (max: number) => z.string().trim().min(1).max(max);

/** A value the work item must have by now. */
export function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new StepFailed(`The work item has no ${what} yet`);
  return value;
}

/** Martin's answer to the hold before this step, for its prompt, if he wrote one. */
export const answerOf = (state: WorkItemState) => state.answer?.text;

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A hold, as the event the line appends for it. */
export function holdDraft(actor: NewEvent['actor'], hold: PayloadOf<'hold.started'>): Draft {
  const summary =
    hold.kind === 'approval'
      ? 'Waiting for Martin to merge'
      : hold.kind === 'question'
        ? 'A question for Martin'
        : `Held for Martin at ${hold.stage}`;
  return { type: 'hold.started', actor, summary, payload: hold };
}
