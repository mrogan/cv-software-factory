import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobForToken } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { stepFrom } from '../../../runner/src/step.ts';
import { coder } from '../../src/line/agents/coder.ts';
import { BENCH_DIR, bench, type RunnerSteps } from '../../src/line/bench/bench.ts';
import { FIXTURE_WORK_ITEM, FIXTURES } from '../../src/line/bench/fixtures.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('bench');
});
afterEach(() => database?.end());

const fixture =
  FIXTURES.coder['off-by-one'] ??
  (() => {
    throw new Error('The coder has no off-by-one fixture.');
  })();
const handback = { ending: 'finished' as const, patch: 'diff', note: 'Fixed it.', turns: 9, session: 's' };

/** The runner's steps as the bench calls them, keeping what each was given and what the agent saw. */
function runner(answer: (env: NodeJS.ProcessEnv) => Promise<unknown>) {
  const seen: { prepare?: NodeJS.ProcessEnv; agent?: NodeJS.ProcessEnv; home?: string[]; token?: unknown } = {};
  const steps: RunnerSteps = {
    prepare: async (env) => {
      seen.prepare = env;
    },
    runAgent: async (env, options) => {
      expect(options.checkFence).toBe(false);
      seen.agent = env;
      seen.home = existsSync(join(String(env.HOME), '.claude')) ? ['.claude'] : [];
      seen.token = await jobForToken(database.writer, env.ANTHROPIC_API_KEY ?? '');
      const { job, workItem } = seen.token as { job: string; workItem: string };
      for (const outcome of ['answered', 'replayed', 'replayed']) {
        await database.writer`
          insert into model_calls (id, agent, work_item, provider, model, question_set, duration_ms, outcome, job)
          values (${crypto.randomUUID()}, 'coder', ${workItem}, 'local', 'qwen/qwen3.8-27b', 'messages', 10,
                  ${outcome}, ${job})`;
      }
      return { ...handback, result: await answer(env) };
    },
  };
  return { seen, steps };
}

describe('the bench', () => {
  it("runs the agent's own step on a fixture, in a fixed folder with a fresh home, and ends its token", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    // What an earlier run, or the developer's own Claude Code, left in the agent's home.
    mkdirSync(join(dir, 'home', '.claude'), { recursive: true });
    writeFileSync(join(dir, 'home', '.claude.json'), '{}');
    const { seen, steps } = runner(async () => ({ title: 'fix(smoke): count the last index from zero' }));
    const benched = await bench({
      agent: 'coder',
      fixture,
      sql: database.writer,
      gateway: 'http://localhost:8180',
      dir,
      runner: steps,
      log: () => {},
    });

    const step = stepFrom(seen.agent);
    expect(step).toMatchObject({ agent: 'coder', commit: fixture.commit, seed: fixture.seed, result: true });
    expect(step.prompt).toBe(coder.prompt(fixture.input));
    expect(step.maxTurns).toBe(coder.maxTurns);
    expect(seen.prepare?.RUNNER_STEP).toBe(seen.agent?.RUNNER_STEP);
    expect(seen.agent).toMatchObject({
      WORK: join(dir, 'work'),
      HOME: join(dir, 'home'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      ANTHROPIC_BASE_URL: 'http://localhost:8180',
    });
    expect(seen.home).toEqual([]);
    expect(existsSync(join(dir, 'home', '.claude.json'))).toBe(false);
    // None of the developer's own environment reaches the agent but where to find its tools.
    expect(Object.keys(seen.agent ?? {}).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BASE_URL',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_NOSYSTEM',
      'HOME',
      'PATH',
      'RUNNER_STEP',
      'WORK',
    ]);
    // The prompt names the fixture's work item; the token, and so the spend it is capped by, one of the run's own.
    expect(step.prompt).toContain(`#${FIXTURE_WORK_ITEM}`);
    expect(seen.token).toMatchObject({ workItem: expect.stringMatching(/^bench-/), agent: 'coder' });
    expect(await jobForToken(database.writer, seen.agent?.ANTHROPIC_API_KEY ?? '')).toBeUndefined();

    expect(benched.result).toEqual({ fits: true, value: { title: 'fix(smoke): count the last index from zero' } });
    expect(benched.calls).toEqual({ answered: 1, replayed: 2 });

    // A second run caps its spend apart from the first, with the same prompt.
    const second = runner(async () => ({ title: 'fix(smoke): count the last index from zero' }));
    await bench({
      agent: 'coder',
      fixture,
      sql: database.writer,
      gateway: 'http://gw',
      dir,
      runner: second.steps,
      log: () => {},
    });
    expect(stepFrom(second.seen.agent).prompt).toBe(step.prompt);
    expect((second.seen.token as { workItem: string }).workItem).not.toBe(
      (seen.token as { workItem: string }).workItem,
    );
  });

  it("works in the developer's own folder, not one every user of the machine shares", () => {
    expect(BENCH_DIR.startsWith(`${homedir()}/`)).toBe(true);
  });

  it("says why a result does not fit the agent's schema, and ends the token when the step throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const options = {
      agent: 'coder' as const,
      fixture,
      sql: database.writer,
      gateway: 'http://gw',
      dir,
      log: () => {},
    };
    const misfit = await bench({ ...options, runner: runner(async () => ({ title: 'Fixed the bug' })).steps });
    expect(misfit.result).toMatchObject({ fits: false, problems: [expect.stringMatching(/^title: /)] });

    const { seen, steps } = runner(async () => {
      throw new Error('The SDK fell over.');
    });
    await expect(bench({ ...options, commit: 'b'.repeat(40), runner: steps })).rejects.toThrow('The SDK fell over.');
    expect(stepFrom(seen.agent).commit).toBe('b'.repeat(40));
    expect(await jobForToken(database.writer, seen.agent?.ANTHROPIC_API_KEY ?? '')).toBeUndefined();
  });
});
