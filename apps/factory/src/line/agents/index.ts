/** Every agent the line runs, by name. */
import type { LineAgent } from '../machine.ts';
import type { Agent } from './agent.ts';
import { coder } from './coder.ts';
import { describer } from './describer.ts';
import { planner } from './planner.ts';
import { reviewer } from './reviewer.ts';

export const AGENTS = { planner, coder, reviewer, describer } as const;

/** The agents as the line runs them, whatever each one's input and result. */
export type Agents = Record<LineAgent, Agent>;
