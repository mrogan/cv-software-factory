/**
 * The bench: one agent's step on a developer's machine, with no cluster, for working on the agent's prompt. It runs
 * the step as a runner does, with the runner's own prepare and agent steps, on a fixture's invented work, against a
 * gateway on the host; it does not fence the agent, which has the machine's network.
 *
 * What makes a second run send the same requests, so the gateway's cassettes replay it: the step works in a fixed
 * folder, `BENCH_DIR`, since its path is in the prompt; the agent's home is emptied before each run, so no session,
 * setting or memory of an earlier one (or of the developer's own Claude Code) reaches it; and it has none of the
 * developer's environment but `PATH`, and no git settings but the checkout's. The prepare step commits a fixture's
 * seed under a fixed message at a fixed time, and gives the checkout's files that time; the gateway keys a call
 * without the date and a test run's times. The folder is the developer's own, in their home's cache, so no other
 * user of the machine can plant anything in it, and two developers' benches never wipe each other's.
 *
 * The step takes a job token like any other, so the gateway audits each call in `model_calls` with the job, and the
 * bench counts from there how many calls a model answered and how many the cassettes replayed. The token names a work
 * item of its own for each run, not the fixture's: the gateway caps what a work item spends over all time, so runs
 * that shared one would soon use up its cap for good. The prompt keeps the fixture's, so the cassettes still replay.
 */
import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { endJobToken, issueJobToken } from '@software-factory/store';
import type { Sql } from 'postgres';
import type { AgentOptions } from '../../../../runner/src/agent.ts';
import type { Handback, Step } from '../../../../runner/src/step.ts';
import { oneRunWorkItem } from '../../runners/smoke.ts';
import type { AgentDefinition } from '../agents/agent.ts';
import { AGENTS } from '../agents/index.ts';
import type { LineAgent } from '../machine.ts';
import { APP_REPOSITORY } from '../worker.ts';
import type { Fixture, InputOf } from './fixtures.ts';

/** Where the bench works, the same on every run: the checkout's path is in the agent's prompt. */
export const BENCH_DIR = join(homedir(), '.cache', 'factory-bench');

/** The runner's two steps, as `apps/runner` has them. */
export interface RunnerSteps {
  prepare(env: NodeJS.ProcessEnv, log: (line: string) => void): Promise<void>;
  runAgent(env: NodeJS.ProcessEnv, options: AgentOptions): Promise<Handback>;
}

export interface BenchOptions<A extends LineAgent> {
  agent: A;
  fixture: Fixture<A>;
  /** The app's commit to start from instead of the fixture's. */
  commit?: string | undefined;
  /** As the factory's writer: for the job token, and the audit of the step's calls. */
  sql: Sql;
  gateway: string;
  /** The bench's folder: `BENCH_DIR`, unless a test gives it one of its own. */
  dir?: string | undefined;
  runner: RunnerSteps;
  log: (line: string) => void;
}

export interface Benched {
  job: string;
  handback: Handback;
  /** The handback's result, read through the agent's schema. */
  result: { fits: true; value: unknown } | { fits: false; problems: string[] };
  /** The step's calls, by what came of them: `answered` by a model, `replayed` from a cassette, and so on. */
  calls: Record<string, number>;
  seconds: { prepare: number; agent: number };
}

export async function bench<A extends LineAgent>(o: BenchOptions<A>): Promise<Benched> {
  // Each agent's input fits only its own definition, which the fixture's type holds to.
  const definition = AGENTS[o.agent] as unknown as AgentDefinition<InputOf<A>, unknown>;
  const { input } = o.fixture;
  const dir = o.dir ?? BENCH_DIR;
  const step: Step = {
    agent: o.agent,
    repository: `https://github.com/${APP_REPOSITORY}.git`,
    commit: o.commit ?? o.fixture.commit,
    prompt: definition.prompt(input),
    ...(definition.skill ? { skill: definition.skill } : {}),
    maxTurns: definition.maxTurns,
    result: true,
    ...(o.fixture.seed ? { seed: o.fixture.seed } : {}),
  };
  const home = join(dir, 'home');
  const prepareDir = join(dir, 'prepare');
  for (const fresh of [home, prepareDir]) {
    await rm(fresh, { recursive: true, force: true });
    await mkdir(fresh, { recursive: true });
  }
  const shared = { WORK: join(dir, 'work'), RUNNER_STEP: JSON.stringify(step) };
  const workItem = oneRunWorkItem('bench');
  const job = `${o.agent}-${workItem}-1`;
  const token = await issueJobToken(o.sql, { job, workItem, agent: o.agent });
  try {
    const started = Date.now();
    // The prepare step has the developer's environment, for pnpm's store; the agent never sees it.
    await o.runner.prepare({ ...process.env, ...shared, PREPARE: prepareDir }, o.log);
    const prepared = Date.now();
    const handback = await o.runner.runAgent(
      {
        PATH: process.env.PATH,
        ...shared,
        HOME: home,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        ANTHROPIC_BASE_URL: o.gateway,
        ANTHROPIC_API_KEY: token,
      },
      { checkFence: false, log: o.log },
    );
    const done = Date.now();
    const parsed = definition.schema(input).safeParse(handback.result);
    const rows = await o.sql<{ outcome: string; calls: number }[]>`
      select outcome, count(*)::int as calls from model_calls where job = ${job} group by outcome order by outcome`;
    return {
      job,
      handback,
      result: parsed.success
        ? { fits: true, value: parsed.data }
        : { fits: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'result'}: ${i.message}`) },
      calls: Object.fromEntries(rows.map((r) => [r.outcome, r.calls])),
      seconds: { prepare: Math.round((prepared - started) / 1000), agent: Math.round((done - prepared) / 1000) },
    };
  } finally {
    await endJobToken(o.sql, job);
  }
}
