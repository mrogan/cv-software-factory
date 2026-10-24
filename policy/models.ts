/**
 * The models each agent may use, per profile (spec section 7.1), and the most effort it may be given: the bounds
 * within which Martin chooses from the console's settings (`settings.ts` turns his latest choice into what is in
 * force). The gateway sends an agent's calls to the provider, the pinned model and, for Claude, the effort in force,
 * whatever the runner asked for: a runner cannot choose a dearer model, and every call is priced by a model the
 * gateway knows. Adding a model, or raising an agent's most effort, is a pull request.
 *
 * Human-owned: see `README.md`. Triage is not here: it asks Jev through the gateway's judgements, by question set.
 */
import type { Effort, ModelAgent } from '../packages/events/src/vocabulary.ts';
import type { Profile } from './spend.ts';

/**
 * The agents that call a model through the gateway's Messages API, each from a runner, and Claude's efforts, least
 * first: the events' own words, so a settings event names the same.
 */
export { EFFORTS, type Effort, MODEL_AGENTS, type ModelAgent } from '../packages/events/src/vocabulary.ts';

/** A Claude model, at the effort the gateway sends with each call. */
export interface ClaudeModel {
  provider: 'anthropic' | 'bedrock';
  /** A pinned model, never an alias. */
  model: string;
  effort: Effort;
}

/**
 * The local model, with no effort: LM Studio's Messages API reads none from a request (it honours only
 * `thinking: {type: "disabled"}`). How hard Qwen thinks is LM Studio's Reasoning Effort for the model, saved as the
 * model's default, not on the loaded model, which loses it on a reload. The line runs it at Medium.
 */
export interface LocalModel {
  provider: 'local';
  model: string;
}

export type AgentModel = ClaudeModel | LocalModel;

/** A model a profile offers: where its calls go, and the pinned model. */
export interface Offered {
  provider: AgentModel['provider'];
  model: string;
}

/** What one agent may use on a profile, and what it uses until Martin chooses. */
export interface AgentBounds {
  /** The models it may use, each one the profile offers. */
  models: readonly string[];
  /** The most effort it may be given on a Claude model. */
  maxEffort: Effort;
  /** Its model and effort until Martin chooses, within these bounds. */
  default: { model: string; effort: Effort };
}

export interface ModelPolicy {
  /**
   * The models this profile offers, cheapest first by the gateway's prices (`apps/factory/src/gateway/prices.ts`), so a
   * later one is dearer: a local model costs nothing, and comes first. A test holds the order to the prices.
   */
  models: readonly Offered[];
  agents: Record<ModelAgent, AgentBounds>;
  /**
   * The local model, where a profile has one. Starting the gateway with `ALL_LOCAL=true` sends every agent to it,
   * whatever the settings say: for the unattended runs that test the plumbing rather than the agents, at no cost.
   */
  local: { model: string } | null;
}

const QWEN: Offered = { provider: 'local', model: 'qwen/qwen3.8-27b' };

// Bedrock joins in milestone 11; until then every profile calls Anthropic's API for Claude.
const CLAUDE: readonly Offered[] = [
  { provider: 'anthropic', model: 'claude-haiku-5-5' },
  { provider: 'anthropic', model: 'claude-sonnet-5-5' },
  { provider: 'anthropic', model: 'claude-opus-5-5' },
];

/** Every agent may use every model its profile offers. */
function agentsOn(models: readonly Offered[]): Record<ModelAgent, AgentBounds> {
  const all = models.map((m) => m.model);
  const sonnet = (effort: Effort) => ({ model: 'claude-sonnet-5-5', effort });
  return {
    planner: { models: all, maxEffort: 'high', default: sonnet('medium') },
    coder: { models: all, maxEffort: 'high', default: sonnet('medium') },
    // High effort flags more minor findings, and each one is work for the coder.
    reviewer: { models: all, maxEffort: 'high', default: sonnet('medium') },
    // Sonnet at low was measured against Claude Haiku 4.5 in milestone 5, and kept. A description needs no more than
    // medium.
    describer: { models: all, maxEffort: 'medium', default: sonnet('low') },
  };
}

const LOCAL_MODELS = [QWEN, ...CLAUDE];

export const MODELS: Record<Profile, ModelPolicy> = {
  // Qwen 3.8 27B in LM Studio on Martin's Mac.
  local: { models: LOCAL_MODELS, agents: agentsOn(LOCAL_MODELS), local: { model: QWEN.model } },
  do: { models: CLAUDE, agents: agentsOn(CLAUDE), local: null },
  aws: { models: CLAUDE, agents: agentsOn(CLAUDE), local: null },
};

/** The model a profile offers by its name, if it offers it. */
export const offered = (profile: Profile, model: string): Offered | undefined =>
  MODELS[profile].models.find((m) => m.model === model);

/** How dear a model is on a profile: its place in the profile's models, cheapest first; -1 if it is not offered. */
export const dearness = (profile: Profile, model: string): number =>
  MODELS[profile].models.findIndex((m) => m.model === model);
