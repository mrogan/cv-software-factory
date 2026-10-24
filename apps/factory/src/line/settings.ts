/**
 * Martin's settings as the line reads them, from the same store and the same check as the gateway (`../settings.ts`):
 * where each agent's calls go now, so a step on the local model is given longer, and a work item's cap now, which the
 * line holds at; and, once a step has run, the effort the gateway sent its calls at, which its `model.called` records.
 * Under `ALL_LOCAL`, as on the gateway, every agent's calls go to the local model, which takes no effort.
 */
import type { NewEvent } from '@software-factory/events';
import { type EventWriter, lockAppends } from '@software-factory/store';
import type { Sql } from 'postgres';
import { type InForce, inForce } from '../../../../policy/settings.ts';
import { latestChosen, type SettingsReader } from '../settings.ts';
import type { LineAgent } from './machine.ts';
import type { LineSettings } from './worker.ts';

/** Where an agent's calls go under these settings, or to the local model under `ALL_LOCAL`. */
export const providerUnder = (settings: InForce, allLocal: boolean) => (agent: LineAgent) =>
  allLocal ? ('local' as const) : settings.agents[agent].provider;

/**
 * The line's settings. With the store and a writer, a spend hold is appended only while the work item's cap in force
 * still holds it, read under the lock every append takes: a save of the settings that raises the cap is appended
 * under it too, so it lands either before (no hold) or after (and answers the hold), never between.
 */
export function lineSettings(
  reader: SettingsReader,
  allLocal: boolean,
  store?: { sql: Sql; events: Pick<EventWriter, 'appendWithin'> },
): LineSettings {
  return {
    ...(store && {
      holdForSpend: (hold: NewEvent, spentUsd: number) =>
        store.sql.begin(async (tx) => {
          await lockAppends(tx);
          const cap = inForce(reader.profile, await latestChosen(tx)).caps.workItemUsd;
          if (spentUsd < cap) return false;
          await store.events.appendWithin(tx, hold);
          return true;
        }) as Promise<boolean>,
    }),
    now: async () => {
      const now = await reader.now();
      return { providerOf: providerUnder(now, allLocal), workItemLimitUsd: now.caps.workItemUsd };
    },
    effortOf: async (job, agent) => {
      const model = allLocal ? undefined : (await reader.forJob(job))?.agents[agent];
      return model?.provider === 'local' ? undefined : model?.effort;
    },
  };
}
