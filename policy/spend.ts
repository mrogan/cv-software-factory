/**
 * What the factory may spend on models (spec section 6, guardrail 7). One cap covers every model provider, so
 * Jev and the Anthropic API draw on the same budget. A day is a UTC day and a month is a UTC calendar month.
 *
 * Human-owned: see `README.md`. The gateway reads this file and refuses a call that would start once a cap
 * has been reached.
 */

/** The deployment profiles that call models. `FACTORY_PROFILE` names one. */
export const PROFILES = ['local', 'do', 'aws'] as const;
export type Profile = (typeof PROFILES)[number];

export interface SpendPolicy {
  /** The most the factory spends in a UTC day, in US dollars. */
  dayUsd: number;
  /** The most it spends in a UTC month, or null for no monthly cap. */
  monthUsd: number | null;
  /** The most one work item may cost across all its calls. */
  workItemUsd: number;
}

export const SPEND: Record<Profile, SpendPolicy> = {
  // $5 a work item while milestone 5 measures what a fix costs: the coder alone was priced at $0.50 to $2.50. The
  // measured figure sets every profile's cap at the end of the milestone.
  local: { dayUsd: 20, monthUsd: null, workItemUsd: 5 },
  do: { dayUsd: 20, monthUsd: 100, workItemUsd: 2 },
  aws: { dayUsd: 20, monthUsd: 100, workItemUsd: 2 },
};
