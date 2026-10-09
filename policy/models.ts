/**
 * Which model each agent uses, per profile (spec section 7.1). The gateway reads this and sends an agent's calls to
 * the provider and the pinned model named here, at the effort named here for Claude, whatever the runner asked for: a
 * runner cannot choose a dearer model, and every call is priced by a model the gateway knows.
 *
 * Human-owned: see `README.md`. Triage is not here: it asks Jev through the gateway's judgements, by question set.
 */
import type { Profile } from './spend.ts';

/** The agents that call a model through the gateway's Messages API, each from a runner. */
export const MODEL_AGENTS = ['planner', 'coder', 'reviewer', 'describer'] as const;
export type ModelAgent = (typeof MODEL_AGENTS)[number];

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
 * model's default, not on the loaded model, which loses it on a reload. The line runs it at Low.
 */
export interface LocalModel {
  provider: 'local';
  model: string;
}

export type AgentModel = ClaudeModel | LocalModel;

export interface ModelPolicy {
  agents: Record<ModelAgent, AgentModel>;
  /**
   * The local model, where a profile has one. Starting the gateway with `ALL_LOCAL=true` sends every agent to it:
   * for the unattended runs that test the plumbing rather than the agents, at no cost.
   */
  local: { model: string } | null;
}

const CLAUDE: Record<ModelAgent, ClaudeModel> = {
  planner: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  coder: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  // High effort flags more minor findings, and each one is work for the coder.
  reviewer: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'medium' },
  // Measured against Claude Haiku 4.5 in milestone 5.
  describer: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' },
};

export const MODELS: Record<Profile, ModelPolicy> = {
  // Qwen 3.8 27B in LM Studio on Martin's Mac.
  local: { agents: CLAUDE, local: { model: 'qwen/qwen3.8-27b' } },
  do: { agents: CLAUDE, local: null },
  // Bedrock joins in milestone 11; until then `aws` calls Anthropic's API too.
  aws: { agents: CLAUDE, local: null },
};

/** The model an agent's calls go to on a profile, with every agent sent to the local model when asked. */
export function modelFor(profile: Profile, agent: ModelAgent, allLocal = false): AgentModel {
  const policy = MODELS[profile];
  const chosen = policy.agents[agent];
  if (!allLocal) return chosen;
  if (!policy.local) throw new Error(`The ${profile} profile has no local model to send every agent to.`);
  return { provider: 'local', model: policy.local.model };
}
