/**
 * The bench's fixtures: invented work for each agent, from which its module builds the prompt the line would send.
 * A fixture names the app's commit it starts from, pinned, so a step recorded from it replays from the cassettes
 * for as long as they are kept; and, for a defect the app does not have, a seed the prepare step commits as the base.
 *
 * Every fixture is invented: a ticket, a spec or a pull request no visitor wrote. A cassette recorded from one holds
 * only that and the app's public code.
 */
import { SMOKE_SCOPE, SMOKE_SEED } from '../../runners/smoke.ts';
import type { Agents } from '../agents/index.ts';
import type { LineAgent } from '../machine.ts';

export interface Fixture<A extends LineAgent> {
  /** What the fixture asks of the agent, in a line. */
  about: string;
  /** The app's commit the step starts from. */
  commit: string;
  /** A patch committed on the commit as the step's base. */
  seed?: string;
  input: Parameters<Agents[A]['prompt']>[0];
}

/** The app's main when the smoke run's seed was last tried on it. */
const APP_MAIN = 'd487739846fd73c2af39652960aa65ed4cdb8422';

export const FIXTURES: { [A in LineAgent]: Record<string, Fixture<A>> } = {
  planner: {},
  coder: {
    'off-by-one': {
      about: "the smoke run's seeded off-by-one: `lastIndex` returns one past a list's last index",
      commit: APP_MAIN,
      seed: SMOKE_SEED,
      input: {
        workItem: '999999999',
        round: 1,
        spec: {
          outcome: "`lastIndex` in src/smoke.ts returns the index of a list's last item.",
          criteria: [
            { given: 'a list of three items', when: '`lastIndex` is asked for its last index', expect: 'it returns 2' },
          ],
          scope: SMOKE_SCOPE,
          risks: [],
          rollout: 'Nothing calls `lastIndex` yet, so the fix ships as it is.',
        },
      },
    },
  },
  reviewer: {},
  describer: {},
};
