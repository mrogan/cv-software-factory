/**
 * What a runner's job is told, through its environment, and what it hands back. The line writes the first and reads
 * the second (`apps/factory/src/runners`); the shapes are here so both sides agree.
 *
 *     RUNNER_STEP   the step, as JSON (`Step`)
 *     WORK          the job's volume, which lives as long as the work item (default /work)
 *
 * The agent pod also has ANTHROPIC_BASE_URL (the gateway), ANTHROPIC_API_KEY (its job token, which is not a key) and
 * HANDBACK_URL (the line's handback endpoint). The prepare pod has neither.
 */
import { join } from 'node:path';

export interface Step {
  /** The agent: planner, coder, reviewer or describer. */
  agent: string;
  /** The app's repository, to clone over HTTPS, and the commit to start from. */
  repository: string;
  commit: string;
  /** What the agent is asked to do. */
  prompt: string;
  /** The skill the prompt names, which the runner tells the agent to use rather than leaving it to choose. */
  skill?: string;
  maxTurns: number;
  /** The agent's own session to carry on, for a round after review. */
  resume?: string;
  /**
   * A patch applied to the checkout before the agent starts, and committed as its base: the smoke run's seeded
   * defect, in a scratch copy of the app. Never set for real work.
   */
  seed?: string;
}

export type Ending = 'finished' | 'max-turns' | 'failed';

/** What the agent pod sends the line's handback endpoint at the end of its step. */
export interface Handback {
  ending: Ending;
  /** The changes the agent made to the checkout, as a unified diff against where it started. Empty for none. */
  patch: string;
  /** The agent's last word: for the coder, a short note of the decisions it made. */
  note: string;
  turns: number;
  /** The agent's session, to resume in a later round. */
  session: string | null;
  /** Why the step failed, when it did: the SDK's own words. */
  error?: string;
}

export const work = (env = process.env) => env.WORK ?? '/work';
export const repoDir = (env = process.env) => join(work(env), 'repo');

export function stepFrom(env = process.env): Step {
  const text = env.RUNNER_STEP;
  if (!text) throw new Error('RUNNER_STEP is not set: the job says what to do there.');
  const step = JSON.parse(text) as Step;
  for (const field of ['agent', 'repository', 'commit', 'prompt'] as const) {
    if (typeof step[field] !== 'string' || !step[field]) throw new Error(`RUNNER_STEP has no ${field}.`);
  }
  if (!/^[0-9a-f]{40}$/.test(step.commit)) throw new Error('RUNNER_STEP.commit is not a full commit sha.');
  if (!Number.isInteger(step.maxTurns) || step.maxTurns < 1) throw new Error('RUNNER_STEP.maxTurns is not a count.');
  return step;
}
