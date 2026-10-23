/**
 * Martin's settings as the line reads them, from the same store and the same check as the gateway (`../settings.ts`):
 * where each agent's calls go now, so a step on the local model is given longer, and a work item's cap now, which the
 * line holds at; and, once a step has run, the effort the gateway sent its calls at, which its `model.called` records.
 * Under `ALL_LOCAL`, as on the gateway, every agent's calls go to the local model, which takes no effort.
 */
import type { InForce } from '../../../../policy/settings.ts';
import type { SettingsReader } from '../settings.ts';
import type { LineAgent } from './machine.ts';
import type { LineSettings } from './worker.ts';

/** Where an agent's calls go under these settings, or to the local model under `ALL_LOCAL`. */
export const providerUnder = (settings: InForce, allLocal: boolean) => (agent: LineAgent) =>
  allLocal ? ('local' as const) : settings.agents[agent].provider;

export function lineSettings(reader: SettingsReader, allLocal: boolean): LineSettings {
  return {
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
