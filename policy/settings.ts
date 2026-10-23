/**
 * Martin's settings within policy: each agent's model and effort, and the spend caps, as he chose them in the console
 * (`settings.changed`), checked against the bounds in `models.ts` and `spend.ts`. This is the one check: the gateway,
 * the line, the admin service and the console each turn the latest settings event into the settings in force with
 * `inForce`, so all four agree on what is in force.
 *
 * Settings are checked where they are read, not only where they are written: whatever an event says, anything outside
 * policy is not in force, and policy's default is, field by field. Zero, null and anything that is not a finite number
 * are never "no cap". The admin service refuses a save that is outside policy too.
 *
 * Human-owned: see `README.md`.
 */
import { type AgentModel, dearness, EFFORTS, type Effort, MODEL_AGENTS, MODELS, type ModelAgent } from './models.ts';
import { CEILINGS, type Profile, SPEND, type SpendPolicy } from './spend.ts';

/** What a settings event carries: Martin's choice of every field. */
export interface Chosen {
  agents: Record<ModelAgent, { model: string; effort?: Effort }>;
  caps: { dayUsd: number; monthUsd: number | null; workItemUsd: number };
}

/** The settings in force on a profile. */
export interface InForce {
  agents: Record<ModelAgent, AgentModel>;
  caps: SpendPolicy;
  /**
   * The fields the chosen settings gave that policy does not allow, or left out, such as `coder.model` or
   * `caps.dayUsd`: policy's default is in force for each.
   */
  outside: string[];
}

export const CAPS = ['dayUsd', 'monthUsd', 'workItemUsd'] as const;
export type CapField = (typeof CAPS)[number];

/** A cap's name in a change, as the event says it. */
export const CAP_NAMES = { dayUsd: 'day', monthUsd: 'month', workItemUsd: 'work-item' } as const;

/** One field a save changed, with its value before and after. */
export type Change =
  | { field: 'model'; agent: ModelAgent; before: string; after: string }
  | { field: 'effort'; agent: ModelAgent; before: Effort | null; after: Effort | null }
  | {
      field: 'cap';
      cap: (typeof CAP_NAMES)[CapField];
      beforeUsd: number | null;
      afterUsd: number | null;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value);

/** A cap's figure if it is one: a finite number of dollars above nothing, and at most its ceiling. */
const capOf = (value: unknown, ceiling: number): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= ceiling ? value : undefined;

/**
 * The settings in force on a profile, from the latest settings event's payload (or none). The payload is read as
 * anything at all: what is outside policy, or not there, is not in force, and policy's default is.
 */
export function inForce(profile: Profile, chosen?: unknown): InForce {
  const policy = MODELS[profile];
  const given = isRecord(chosen) ? chosen : undefined;
  const outside: string[] = [];
  const agents = {} as Record<ModelAgent, AgentModel>;
  for (const agent of MODEL_AGENTS) {
    const bounds = policy.agents[agent];
    const choice = given && isRecord(given.agents) ? given.agents[agent] : undefined;
    const asked = isRecord(choice) ? choice : {};
    const model =
      typeof asked.model === 'string' && bounds.models.includes(asked.model) ? asked.model : bounds.default.model;
    if (given && model !== asked.model) outside.push(`${agent}.model`);
    const offer = policy.models.find((m) => m.model === model);
    if (!offer) throw new Error(`policy/models.ts: ${agent}'s model ${model} is not one the ${profile} profile offers`);
    if (offer.provider === 'local') {
      // LM Studio sets a local model's effort: one given for it is outside policy, and none is in force.
      if (given && asked.effort !== undefined) outside.push(`${agent}.effort`);
      agents[agent] = { provider: 'local', model };
      continue;
    }
    const within = (effort: unknown): effort is Effort =>
      isEffort(effort) && EFFORTS.indexOf(effort) <= EFFORTS.indexOf(bounds.maxEffort);
    const effort = within(asked.effort) ? asked.effort : bounds.default.effort;
    if (given && effort !== asked.effort) outside.push(`${agent}.effort`);
    agents[agent] = { provider: offer.provider, model, effort };
  }
  const defaults = SPEND[profile];
  const ceilings = CEILINGS[profile];
  const asked = given && isRecord(given.caps) ? given.caps : {};
  // On `local` a month's default is no cap, so a month left as the default is none there, and a figure elsewhere.
  const caps: SpendPolicy = {
    dayUsd: capOf(asked.dayUsd, ceilings.dayUsd) ?? defaults.dayUsd,
    monthUsd: capOf(asked.monthUsd, ceilings.monthUsd) ?? defaults.monthUsd,
    workItemUsd: capOf(asked.workItemUsd, ceilings.workItemUsd) ?? defaults.workItemUsd,
  };
  for (const cap of CAPS) if (given && caps[cap] !== asked[cap]) outside.push(`caps.${cap}`);
  return { agents, caps, outside };
}

/** The settings in force, as a settings event carries them. */
export function chosenOf(settings: InForce): Chosen {
  const agents = {} as Chosen['agents'];
  for (const agent of MODEL_AGENTS) {
    const model = settings.agents[agent];
    agents[agent] = model.provider === 'local' ? { model: model.model } : { model: model.model, effort: model.effort };
  }
  return { agents, caps: { ...settings.caps } };
}

const effortOf = (model: AgentModel): Effort | null => (model.provider === 'local' ? null : model.effort);
const effortRank = (effort: Effort | null) => (effort === null ? -1 : EFFORTS.indexOf(effort));
/** No cap is more than any figure. */
const capRank = (usd: number | null) => usd ?? Number.POSITIVE_INFINITY;

/**
 * What going from one set of settings to another changes, field by field, and which of the access table's actions
 * that is (`policy/access.ts`): a dearer model or more effort is `agent.raise`, a cheaper model or less effort
 * `agent.lower`, and likewise a cap. "Dearer" is by the gateway's prices, which put a local model below every Claude
 * model; a local model takes no effort, below every effort.
 */
export function changesBetween(
  profile: Profile,
  before: InForce,
  after: InForce,
): { changes: Change[]; actions: ('agent.raise' | 'agent.lower' | 'caps.raise' | 'caps.lower')[] } {
  const changes: Change[] = [];
  const actions = new Set<'agent.raise' | 'agent.lower' | 'caps.raise' | 'caps.lower'>();
  for (const agent of MODEL_AGENTS) {
    const [was, is] = [before.agents[agent], after.agents[agent]];
    if (was.model !== is.model) {
      changes.push({ field: 'model', agent, before: was.model, after: is.model });
      actions.add(dearness(profile, is.model) > dearness(profile, was.model) ? 'agent.raise' : 'agent.lower');
    }
    const [from, to] = [effortOf(was), effortOf(is)];
    if (from !== to) {
      changes.push({ field: 'effort', agent, before: from, after: to });
      actions.add(effortRank(to) > effortRank(from) ? 'agent.raise' : 'agent.lower');
    }
  }
  for (const cap of CAPS) {
    const [from, to] = [before.caps[cap], after.caps[cap]];
    if (from === to) continue;
    changes.push({ field: 'cap', cap: CAP_NAMES[cap], beforeUsd: from, afterUsd: to });
    actions.add(capRank(to) > capRank(from) ? 'caps.raise' : 'caps.lower');
  }
  return { changes, actions: [...actions] };
}
