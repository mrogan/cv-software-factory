import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobForToken } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { stepFrom } from '../../../runner/src/step.ts';
import { coder, coderInputAfterRefusal } from '../../src/line/agents/coder.ts';
import { BENCH_DIR, bench, lastStep, type RunnerSteps } from '../../src/line/bench/bench.ts';
import { FIXTURE_WORK_ITEM, FIXTURES } from '../../src/line/bench/fixtures.ts';
import { LIMITS } from '../../src/line/machine.ts';

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
const handback = { ending: 'finished' as const, patch: '', note: 'Fixed it.', turns: 9, session: 's' };
const CODED = {
  title: 'fix(smoke): count the last index from zero',
  note: 'lastIndex counted from one; a test shows it.',
};
const PATCH = (path: string) => `diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-old
+new
`;

/** The runner's steps as the bench calls them, keeping what each was given and what the agent saw. */
function runner(answer: (env: NodeJS.ProcessEnv) => Promise<unknown>, patches: string[] = []) {
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
      return { ...handback, patch: patches.shift() ?? '', result: await answer(env) };
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
    const { seen, steps } = runner(async () => CODED);
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

    expect(benched.result).toEqual({ fits: true, value: CODED });
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
    const misfit = await bench({
      ...options,
      runner: runner(async () => ({ ...CODED, title: 'Fixed the bug' })).steps,
    });
    expect(misfit.result).toMatchObject({ fits: false, problems: [expect.stringMatching(/^title: /)] });

    const { seen, steps } = runner(async () => {
      throw new Error('The SDK fell over.');
    });
    await expect(bench({ ...options, commit: 'b'.repeat(40), runner: steps })).rejects.toThrow('The SDK fell over.');
    expect(stepFrom(seen.agent).commit).toBe('b'.repeat(40));
    expect(await jobForToken(database.writer, seen.agent?.ANTHROPIC_API_KEY ?? '')).toBeUndefined();
  });

  it('sends a coder’s patch the fence refuses back once, resuming its session in the same home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const homes: boolean[] = [];
    const prompts: string[] = [];
    const { steps } = runner(
      async (env) => {
        prompts.push(stepFrom(env).prompt);
        homes.push(existsSync(join(String(env.HOME), 'kept')));
        writeFileSync(join(String(env.HOME), 'kept'), 'the session');
        return CODED;
      },
      [PATCH('src/smoke.ts') + PATCH('src/app.ts'), PATCH('src/smoke.ts')],
    );
    const resumed: (string | undefined)[] = [];
    const benched = await bench({
      agent: 'coder',
      fixture,
      sql: database.writer,
      gateway: 'http://gw',
      dir,
      runner: {
        ...steps,
        runAgent: (env, options) => {
          resumed.push(stepFrom(env).resume);
          return steps.runAgent(env, options);
        },
      },
      log: () => {},
    });
    expect(benched.fence).toMatchObject({ ok: false, outside: ['src/app.ts'] });
    expect(benched.fence?.output).toContain('refused src/app.ts +1 −1');
    expect(benched.again?.fence).toMatchObject({ ok: true });
    expect(resumed).toEqual([undefined, 's']);
    expect(homes).toEqual([false, true]);
    expect(prompts[1]).toBe(coder.prompt(coderInputAfterRefusal(fixture.input, String(benched.fence?.output), 's')));
  });

  it('sends a coder back no more often than the line does, and fails the run when the fence refuses the last step', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-'));
    const strays = Array.from({ length: LIMITS.fenceRefusals + 1 }, () => PATCH('src/smoke.ts') + PATCH('src/app.ts'));
    const { steps } = runner(async () => CODED, strays);
    let ran = 0;
    const benched = await bench({
      agent: 'coder',
      fixture,
      sql: database.writer,
      gateway: 'http://gw',
      dir,
      runner: {
        ...steps,
        runAgent: (env, options) => {
          ran += 1;
          return steps.runAgent(env, options);
        },
      },
      log: () => {},
    });
    expect(ran).toBe(LIMITS.fenceRefusals);
    expect(lastStep(benched).fence).toMatchObject({ ok: false });
    expect(lastStep(benched).again).toBeUndefined();
  });
});
