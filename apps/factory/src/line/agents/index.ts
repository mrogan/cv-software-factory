/** Every agent the line runs, by name. */
import { coder } from './coder.ts';
import { describer } from './describer.ts';
import { planner } from './planner.ts';
import { reviewer } from './reviewer.ts';

export const AGENTS = { planner, coder, reviewer, describer } as const;

export type Agents = typeof AGENTS;
