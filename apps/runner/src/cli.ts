#!/usr/bin/env node
/**
 * What a runner's pods run: `runner prepare` in the prepare pod, `runner agent` in the agent pod. Settings come from
 * the environment the job gives them (`step.ts`).
 */
import { handBack, runAgent } from './agent.ts';
import { prepare } from './prepare.ts';

const [command] = process.argv.slice(2);
if (command === 'prepare') {
  await prepare();
} else if (command === 'agent') {
  const handback = await runAgent();
  console.log(
    `the agent ${handback.ending} after ${handback.turns} turns, with a patch of ${handback.patch.length} characters`,
  );
  await handBack(process.env, handback);
} else {
  console.log('Usage:\n  runner prepare\n  runner agent');
  process.exitCode = 2;
}
