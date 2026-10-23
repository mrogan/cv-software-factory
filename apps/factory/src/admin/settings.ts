/**
 * Saving Martin's settings from the console: each agent's model and effort, and the spend caps, within policy
 * (`policy/settings.ts`). One save is one route, `POST /admin/settings`, and one `settings.changed` event, carrying every
 * setting as it now stands and each field the save changed, with its value before and after.
 *
 * - A save gives only what it changes; the rest stays as it is in force.
 * - A save outside policy is refused whole, having changed nothing: a model the agent may not use on this profile, more
 *   effort than its most, an effort for a local model (LM Studio sets that), or a cap that is not a figure above
 *   nothing and at most its ceiling. The gateway and the line check what they read again, whatever is written here.
 * - What a save does is the access table's (`policy/access.ts`): a dearer model or more effort is `agent.raise`, and
 *   raising a cap `caps.raise`, which need the passkey again; lowering either does not. One save that raises anything
 *   and lowers the rest asks for it.
 * - Raising a work item's cap answers each `spend` hold the new cap clears: a `hold.answered` approving it, in the same
 *   transaction as the settings, saying the cap was raised. The line then carries on with that work item. Raising the
 *   day's or the month's cap answers nothing: the gateway clears its own `spend.capped` once spend is under the new cap.
 *
 * Saves are taken one at a time, each against the settings in force as it is taken.
 */
import { randomUUID } from 'node:crypto';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { fromMartin } from '@software-factory/store';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { ACCESS } from '../../../../policy/access.ts';
import { MODEL_AGENTS, MODELS, type ModelAgent } from '../../../../policy/models.ts';
import {
  CAP_NAMES,
  type CapField,
  type Change,
  type Chosen,
  changesBetween,
  chosenOf,
  type InForce,
  inForce,
} from '../../../../policy/settings.ts';
import { type Profile, SPEND } from '../../../../policy/spend.ts';
import { latestChosen } from '../settings.ts';
import { type AdminStore, adminEvent, Refused, type Session } from './store.ts';

/** What a save may give: any of the agents' models and efforts, and any of the caps, as the page has them. */
export const SAVE = z.strictObject({
  agents: z
    .partialRecord(
      z.enum(MODEL_AGENTS),
      z.strictObject({ model: z.string().max(100).optional(), effort: z.string().max(20).optional() }),
    )
    .optional(),
  caps: z
    .strictObject({
      dayUsd: z.number().optional(),
      /** None: the profile's default, which on `local` is no cap. */
      monthUsd: z.number().nullable().optional(),
      workItemUsd: z.number().optional(),
    })
    .optional(),
});
export type Save = z.infer<typeof SAVE>;

/** What a save did: the settings now in force, what it changed, and the work items whose `spend` holds it answered. */
export interface Saved {
  settings: Chosen;
  changes: Change[];
  answered: string[];
}

/**
 * Every setting as it stands, with the save's on top: what the save asks to be in force, as yet unchecked. A field the
 * save leaves out stays as it is; one it gives in the wrong shape is checked as given, and refused.
 */
function asked(profile: Profile, before: InForce, save: Save): { agents: Record<string, object>; caps: object } {
  const next = chosenOf(before);
  const agents: Record<string, object> = { ...next.agents };
  for (const agent of MODEL_AGENTS) {
    const given = save.agents?.[agent];
    // A local model in force has no effort to keep: a move to Claude that names none starts at the agent's default.
    const effort = next.agents[agent].effort ?? MODELS[profile].agents[agent].default.effort;
    if (given) agents[agent] = { ...next.agents[agent], effort, ...given };
  }
  // A month's cap of none is the profile's default: none on `local`, a figure elsewhere.
  const caps = { ...next.caps, ...save.caps };
  if (save.caps?.monthUsd === null) caps.monthUsd = SPEND[profile].monthUsd;
  return { agents, caps };
}

/** Each part of a save that policy does not allow, in words; none for a save within it. */
export function outsidePolicy(profile: Profile, before: InForce, save: Save): string[] {
  const after = inForce(profile, asked(profile, before, save));
  const words: string[] = after.outside.map((field) => {
    const [owner = '', what = ''] = field.split('.');
    const name =
      owner === 'caps' ? `the ${CAP_NAMES[what as CapField].replace('-', ' ')}'s cap` : `the ${owner}'s ${what}`;
    return `${name} is outside policy`;
  });
  for (const [agent, given] of Object.entries(save.agents ?? {})) {
    const model = after.agents[agent as ModelAgent];
    if (given?.effort !== undefined && model.provider === 'local') {
      words.push(`the ${agent}'s effort is set in LM Studio for ${model.model}, not here`);
    }
  }
  return words;
}

/** A change in words, as the summary says it: "the coder's effort, medium → high". */
export function changeWords(change: Change): string {
  const usd = (figure: number | null) => (figure === null ? 'none' : `$${figure.toFixed(2)}`);
  switch (change.field) {
    case 'model':
      return `the ${change.agent}'s model, ${change.before} → ${change.after}`;
    case 'effort':
      return `the ${change.agent}'s effort, ${change.before ?? 'none'} → ${change.after ?? 'none'}`;
    case 'cap':
      return `the ${change.cap === 'work-item' ? 'work item' : change.cap}'s cap, ${usd(change.beforeUsd)} → ${usd(change.afterUsd)}`;
  }
}

/** The summary of a save: its changes in words, or how many there were when the words would not fit. */
function summaryOf(changes: Change[]): string {
  const words = `Martin changed ${changes.map(changeWords).join('; ')}`;
  return words.length <= 200 ? words : `Martin changed ${changes.length} settings`;
}

/**
 * The work items held for spend whose hold a work item's cap of `capUsd` clears, as they stand: the last hold
 * started, not answered, of a work item not closed, with less spent than the new cap. A hold from before the line
 * recorded the spend is cleared when the new cap is above the one it reached.
 */
async function spendHoldsCleared(
  tx: TransactionSql,
  capUsd: number,
): Promise<{ workItem: string; spentUsd: number }[]> {
  const rows = await tx<{ work_item: string; spent: number | null; limit: number | null }[]>`
    with last as (
      select distinct on (e.work_item) e.work_item, e.type, e.payload
      from events e
      where e.work_item is not null and e.type in ('hold.started', 'hold.answered') and ${fromMartin(tx, 'e')}
      order by e.work_item, e.seq desc
    ), ended as (
      select distinct on (e.work_item) e.work_item, e.type
      from events e where e.work_item is not null and e.type in ('work-item.closed', 'work-item.reopened')
      order by e.work_item, e.seq desc
    )
    select l.work_item, (l.payload->>'spentUsd')::float8 as spent, (l.payload->>'limitUsd')::float8 as limit
    from last l left join ended d on d.work_item = l.work_item
    where l.type = 'hold.started' and l.payload->>'cause' = 'spend'
      and d.type is distinct from 'work-item.closed'
    order by length(l.work_item), l.work_item`;
  return rows.flatMap((row) => {
    const spentUsd = row.spent ?? row.limit;
    return spentUsd !== null && spentUsd < capUsd ? [{ workItem: row.work_item, spentUsd }] : [];
  });
}

/** Martin's approval of a work item's `spend` hold, since its cap was raised past what it has spent. */
function holdAnswered(workItem: string, capUsd: number, spentUsd: number): NewEvent {
  const cap = `$${capUsd.toFixed(2)}`;
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type: 'hold.answered',
    version: VERSIONS['hold.answered'],
    actor: 'martin',
    summary: `Martin raised a work item's cap to ${cap}, so the work item carries on`,
    payload: {
      decision: 'approved',
      answer: `Martin raised a work item's cap to ${cap}, past the $${spentUsd.toFixed(2)} this one has spent.`,
    },
    artifacts: [],
  } as NewEvent;
}

/** Saves Martin's settings, or refuses having changed nothing. */
export async function saveSettings(store: AdminStore, profile: Profile, session: Session, save: Save): Promise<Saved> {
  return store
    .record(
      async (tx) => {
        // One save at a time, each against what is in force as it is taken.
        await tx`select pg_advisory_xact_lock(hashtext('settings'))`;
        const before = inForce(profile, await latestChosen(tx));
        const outside = outsidePolicy(profile, before, save);
        if (outside.length) throw new Refused('policy', 422, `That is outside policy: ${outside.join('; ')}.`);
        const after = inForce(profile, asked(profile, before, save));
        const { changes, actions } = changesBetween(profile, before, after);
        if (actions.some((action) => ACCESS[action].stepUp) && !session.steppedUp) {
          throw new Refused('step-up', 403, 'This needs your passkey again.');
        }
        const raised = after.caps.workItemUsd > before.caps.workItemUsd;
        const holds = raised ? await spendHoldsCleared(tx, after.caps.workItemUsd) : [];
        return { after, changes, holds };
      },
      ({ after, changes, holds }) =>
        changes.length
          ? [
              adminEvent('settings.changed', summaryOf(changes), { ...chosenOf(after), changes }),
              ...holds.map((hold) => holdAnswered(hold.workItem, after.caps.workItemUsd, hold.spentUsd)),
            ]
          : [],
    )
    .then(({ after, changes, holds }) => ({
      settings: chosenOf(after),
      changes,
      answered: holds.map((hold) => hold.workItem),
    }));
}
