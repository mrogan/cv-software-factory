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
import type { Handback, Step } from '../../runners/steps.ts';
import type { Draft } from '../gates.ts';
import type { LineAgent, WorkItemState } from '../machine.ts';
import type { Signal } from './evidence.ts';

/** A step that went wrong in a way the line counts against it: no handback, a result refused, an action refused. */
export class StepFailed extends Error {
  override name = 'StepFailed';
}

/**
 * The work item moved under a step, as when its branch moved while the agent worked: the handback is no use, and
 * the step runs again from where the work item is now, without counting against it.
 */
export class StepStale extends Error {
  override name = 'StepStale';
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
  /**
   * The commit a pull request's diff is taken against: where its branch left main for a step that reads the change
   * (`readsChange`), its base's head for any other, and the start before there is a pull request.
   */
  base: string;
  /** The session the agent's last step ended with, which a later round may carry on. */
  session: string | null;
  /** Why the step's last attempt failed, if it did, so the agent can be told what not to hand back again. */
  failure: string | null;
  /** The work item's ticket, as its public view has it. Throws `StepFailed` when there is none. */
  ticket(): Promise<PayloadOf<'ticket.opened'>>;
  /** What each sense saw of the work item, from their public views, without a report's signal (`evidence.ts`). */
  signals(): Promise<Signal[]>;
  /** Reads GitHub through the worker. Reading is harmless, so a step may read as it starts. */
  read<K extends ReadName>(read: K, args: ReadArgs[K]): Promise<ReadResult<K>>;
}

/** What an agent's result may do: act in GitHub, each write at most once, and keep its session. */
export interface EffectsContext extends StepContext {
  /**
   * Does `write` once for this handback. A write already done gives back what it gave then. One begun and never
   * recorded (the line crashed, or the store failed, in between) runs again with `again` set, so it can make sure
   * doing it twice does no harm.
   */
  once<T>(name: string, write: (again: boolean) => Promise<T>): Promise<T>;
  act<K extends ActionName>(action: K, args: ActionArgs[K]): Promise<ActionResult<K>>;
  /** Keeps the agent's session, for its next round to resume. */
  keepSession(session: string | null): Promise<void>;
}

export interface AgentDefinition<Input, Result> {
  agent: LineAgent;
  /**
   * The skill the step names, from the runner's plugin (`apps/runner/plugin`): the runner gives the agent that skill
   * alone, and tells it to use it.
   */
  skill?: string;
  /** Turns, and seconds of work, before the step ends unfinished. */
  maxTurns: number;
  deadlineSeconds: number;
  /**
   * Whether the step reads the pull request's change rather than making one. Its base, where the pull request's
   * branch left main as GitHub's diff takes it, is then fetched beside its commit with every commit between, so
   * `git diff base` is the change and `git log base..HEAD` what the coder said of it in each round.
   */
  readsChange?: boolean;
  /** What the step is given, from its work item. Throws `StepFailed` when the work item lacks something it needs. */
  input(context: StepContext): Input | Promise<Input>;
  /**
   * Fields of the result the agent writes as files of their own, by field, with their names: prose, such as a pull
   * request's description, is easier to write well as a Markdown file than inside a JSON string.
   */
  resultFiles?: Record<string, `${string}.md`>;
  prompt(input: Input): string;
  /**
   * The session the step carries on, if it resumes one. The definition decides it from the input alone, as it decides
   * the prompt, so the line and the bench resume the same steps, each with the prompt that fits.
   */
  resume?(input: Input): string | undefined;
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
  readsChange?: boolean;
  resultFiles?: Record<string, `${string}.md`>;
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
        resume: definition.resume?.(input),
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

/** What one step is given beside its agent's definition: where it starts, and what it is asked. */
export interface StepOf {
  /** The app's repository, as `owner/name`. */
  repository: string;
  commit: string;
  /** For a step that reads a change, where its pull request's branch left main. */
  base?: string | undefined;
  prompt: string;
  resume?: string | undefined;
  /** A defect the bench commits as the step's starting point. */
  seed?: string | undefined;
}

/**
 * The runner's step for an agent: what its definition says of every step it takes, with what this one is given. The
 * line and the bench both make their steps here, so a step on the bench is the step the line would send.
 */
export function stepFrom(
  definition: Pick<Agent, 'agent' | 'skill' | 'maxTurns' | 'resultFiles'>,
  { repository, commit, base, prompt, resume, seed }: StepOf,
): Step {
  return {
    agent: definition.agent,
    repository: `https://github.com/${repository}.git`,
    commit,
    ...(base ? { base } : {}),
    prompt,
    ...(definition.skill ? { skill: definition.skill } : {}),
    maxTurns: definition.maxTurns,
    result: true,
    ...(definition.resultFiles ? { resultFiles: definition.resultFiles } : {}),
    ...(seed ? { seed } : {}),
    ...(resume ? { resume } : {}),
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

/** An issue as GitHub reads a reference to one: `#12`, `owner/repo#12`, `GH-12`, or its address. */
const ISSUE = String.raw`(?:(?:[\w.-]+\/[\w.-]+)?#\d+|GH-\d+|https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+)`;

/** Any of GitHub's closing keywords, with or without a colon, before an issue. */
const CLOSES = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+${ISSUE}`, 'i');

/**
 * Whether text would close an issue when it reaches main: in a pull request's description, which the squash commit
 * takes as its message, or in a commit's. Wherever it stands, code included, since a commit's message has no code.
 * The line closes a ticket's issue itself, once the fix is verified in production, never on merge.
 */
export const closesAnIssue = (text: string) => CLOSES.test(text);

/** Markdown's code, fenced or inline, where GitHub notifies nobody. */
const CODE = /(```|~~~)[\s\S]*?(?:\1|$)|`[^`\n]*`/g;

/**
 * Whether Markdown mentions someone (`@name`, or a team's `@org/name`) outside code: published from the App's
 * account, it would notify them. An email address is no mention.
 */
export const mentions = (markdown: string) => /(?:^|[^\w`@./])@[a-z\d]/im.test(markdown.replace(CODE, ''));

/**
 * A fix's pull request title, and so its squash commit's headline: a Conventional Commit of 80 characters at most,
 * which both the coder and the describer write, closing no issue.
 */
export const commitTitle = z
  .string()
  .trim()
  .max(80)
  .regex(
    /^(fix|test|refactor|perf)(\([a-z0-9-]+\))?: \S.{0,70}$/,
    'a Conventional Commit title of 80 characters at most',
  )
  .refine((title) => !closesAnIssue(title), 'no closing keyword before an issue: the issue closes once verified');
