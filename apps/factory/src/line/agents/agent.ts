/**
 * What the line knows of each agent: one module per agent, holding its prompt, the skill it names, its bounds and
 * the schema of the result it hands back. The line runs every agent the same way (`../worker.ts`); everything that
 * makes one agent unlike another is in its module.
 *
 * A prompt is built from typed fields only: a ticket's category and fingerprint, a spec, a pull request's number.
 * Never from a visitor's words, which reach no generative agent.
 */
import { z } from 'zod';
import type { LineAgent } from '../machine.ts';

export interface AgentDefinition<Input, Result> {
  agent: LineAgent;
  /** The skill the prompt names, which the runner tells the agent to use. */
  skill?: string;
  /** Turns, and seconds of work, before the step ends unfinished. */
  maxTurns: number;
  deadlineSeconds: number;
  /**
   * The result the agent writes beside its changes, read through this schema. A result that is missing or that
   * the schema refuses makes a failed step.
   */
  result: z.ZodType<Result>;
  prompt(input: Input): string;
}

/** Text a person reads, as the events take it: trimmed, and not empty. */
export const words = (max: number) => z.string().trim().min(1).max(max);
