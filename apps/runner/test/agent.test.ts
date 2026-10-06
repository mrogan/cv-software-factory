import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent.ts';
import { type ScriptedModel, scriptedModel, type Turn } from './model.ts';

let model: ScriptedModel | undefined;
afterEach(() => model?.close());

/** A job's volume with a checkout of a tiny app in it, as the prepare pod leaves one. */
function volume(): string {
  const work = mkdtempSync(join(tmpdir(), 'runner-'));
  const repo = join(work, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/count.ts'), 'export const count = (xs: unknown[]) => xs.length - 1;\n');
  writeFileSync(join(repo, 'README.md'), '# The shop\n');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '--message', 'base');
  return work;
}

async function run(script: Turn[], { maxTurns = 6, repeat = false, result = false, work = volume() } = {}) {
  model = await scriptedModel(script, { repeat });
  const env = {
    ...process.env,
    WORK: work,
    HOME: join(work, 'home'),
    ANTHROPIC_BASE_URL: model.url,
    ANTHROPIC_API_KEY: 'sfj_job-token',
    RUNNER_STEP: JSON.stringify({
      agent: 'coder',
      repository: 'https://example.invalid/app',
      commit: 'a'.repeat(40),
      prompt: 'Fix the count.',
      maxTurns,
      ...(result ? { result } : {}),
    }),
  };
  return runAgent(env, { checkFence: false, log: () => {} });
}

const bash = (command: string): Turn => ({ tool: 'Bash', input: { command, description: command } });

describe('a runner’s agent', () => {
  it('edits one file, and hands back its patch, its note and its session', async () => {
    const handback = await run([
      bash("sed -i.bak 's/ - 1;/;/' src/count.ts && rm src/count.ts.bak"),
      { text: 'Removed the off-by-one.' },
    ]);
    expect(handback).toMatchObject({
      ending: 'finished',
      note: 'Removed the off-by-one.',
      turns: 2,
      session: expect.any(String),
    });
    expect(handback.patch).toContain('--- a/src/count.ts\n+++ b/src/count.ts');
    expect(handback.patch).toContain('+export const count = (xs: unknown[]) => xs.length;');
    // Its calls carried the job token, and went to the gateway it was given.
    expect(
      model?.requests
        .filter((r) => r.path.startsWith('/v1/messages'))
        .every((r) => r.headers['x-api-key'] === 'sfj_job-token'),
    ).toBe(true);
  });

  it('hands back what the agent committed as well as what it left uncommitted', async () => {
    const handback = await run([
      bash(
        "sed -i.bak 's/ - 1;/;/' src/count.ts && rm src/count.ts.bak && git -c user.name=a -c user.email=a@a.invalid commit -qam fix",
      ),
      bash("echo '# The shop, counted' > README.md"),
      { text: 'Fixed and committed the count.' },
    ]);
    expect(handback.patch).toContain('+export const count = (xs: unknown[]) => xs.length;');
    expect(handback.patch).toContain('+# The shop, counted');
  });

  it('hands back nothing under .claude/, even when the agent committed it', async () => {
    const handback = await run([
      bash(
        "mkdir -p .claude && echo '{}' > .claude/settings.json && sed -i.bak 's/ - 1;/;/' src/count.ts && rm src/count.ts.bak && git add -A && git -c user.name=a -c user.email=a@a.invalid commit -qm fix",
      ),
      { text: 'Fixed and committed the count.' },
    ]);
    expect(handback.patch).toContain('+export const count = (xs: unknown[]) => xs.length;');
    expect(handback.patch).not.toContain('.claude');
  });

  it('hands back a change outside its scope as it is: the line’s fence judges it, not the runner', async () => {
    const handback = await run([
      bash('mkdir -p .github/workflows && echo "on: push" > .github/workflows/sneak.yml'),
      { text: 'Added a workflow.' },
    ]);
    expect(handback.ending).toBe('finished');
    expect(handback.patch).toContain('+++ b/.github/workflows/sneak.yml');
  });

  it('stops at its turn limit, and says so', async () => {
    const handback = await run([bash('echo still thinking')], { maxTurns: 2, repeat: true });
    expect(handback).toMatchObject({ ending: 'max-turns', patch: '', turns: expect.any(Number) });
    expect(handback.error).toMatch(/max_turns|turn/i);
  });

  it('hands back nothing when it changes nothing', async () => {
    const handback = await run([{ text: 'The count is already right; nothing to change.' }]);
    expect(handback).toMatchObject({
      ending: 'finished',
      patch: '',
      note: 'The count is already right; nothing to change.',
    });
  });

  it('hands back the result it wrote outside the checkout, which is no part of the patch', async () => {
    const handback = await run(
      [bash(`echo '{"verdict":"spec","scope":["src/count.ts"]}' > "$WORK/out/result.json"`), { text: 'Planned.' }],
      { result: true },
    );
    expect(handback).toMatchObject({
      ending: 'finished',
      patch: '',
      result: { verdict: 'spec', scope: ['src/count.ts'] },
    });
    expect(handback.error).toBeUndefined();
  });

  it('hands back no result left by an earlier step, and says it wrote none', async () => {
    const work = volume();
    mkdirSync(join(work, 'out'));
    writeFileSync(join(work, 'out/result.json'), '{"verdict":"stale"}');
    const handback = await run([{ text: 'Done.' }], { result: true, work });
    expect(handback).not.toHaveProperty('result');
    expect(handback.error).toBe('The agent wrote no result.');
  });

  it('hands back no result that is not JSON', async () => {
    const handback = await run([bash('echo "not json" > "$WORK/out/result.json"'), { text: 'Done.' }], {
      result: true,
    });
    expect(handback).not.toHaveProperty('result');
    expect(handback.error).toBe('The result is not JSON.');
  });
});
