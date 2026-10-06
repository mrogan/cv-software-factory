import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readResult, runAgent } from '../src/agent.ts';
import { RESULT_BYTES, stepFrom } from '../src/step.ts';
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

interface RunOptions {
  maxTurns?: number;
  repeat?: boolean;
  result?: boolean;
  work?: string;
  skill?: string;
  resultFiles?: Record<string, string>;
}

async function run(
  script: Turn[],
  { maxTurns = 6, repeat = false, result = false, work = volume(), skill, resultFiles }: RunOptions = {},
) {
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
      ...(skill ? { skill } : {}),
      ...(resultFiles ? { resultFiles } : {}),
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

  it('hands back a field written as a file of its own inside its result', async () => {
    const handback = await run(
      [
        bash(`echo '{"title":"fix: count"}' > "$WORK/out/result.json" && printf 'It counts.\\n' > "$WORK/out/body.md"`),
        { text: 'Described.' },
      ],
      { result: true, resultFiles: { body: 'body.md' } },
    );
    expect(handback.result).toEqual({ title: 'fix: count', body: 'It counts.\n' });
    expect(handback.error).toBeUndefined();
  });

  it('hands back no result when a field it writes as a file is missing', async () => {
    const handback = await run([bash(`echo '{"title":"fix: count"}' > "$WORK/out/result.json"`), { text: 'Done.' }], {
      result: true,
      resultFiles: { body: 'body.md' },
    });
    expect(handback).not.toHaveProperty('result');
    expect(handback.error).toBe('The agent wrote no body.');
  });
});

describe('reading a result', () => {
  const out = () => mkdtempSync(join(tmpdir(), 'result-'));

  it('refuses a result file over the bound before it reads it', async () => {
    const dir = out();
    writeFileSync(join(dir, 'result.json'), '{"title":"fix: count"}');
    // Sparse: as big as it says, and nothing to read.
    writeFileSync(join(dir, 'body.md'), '');
    truncateSync(join(dir, 'body.md'), RESULT_BYTES + 1);
    expect(await readResult(join(dir, 'result.json'), { body: join(dir, 'body.md') })).toEqual({
      problem: `The result is over ${RESULT_BYTES} bytes.`,
    });
    truncateSync(join(dir, 'result.json'), RESULT_BYTES + 1);
    expect(await readResult(join(dir, 'result.json'))).toEqual({
      problem: `The result is over ${RESULT_BYTES} bytes.`,
    });
  });

  it('bounds the result and its files together', async () => {
    const dir = out();
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ title: 'x'.repeat(RESULT_BYTES / 2) }));
    writeFileSync(join(dir, 'body.md'), 'y'.repeat(RESULT_BYTES / 2));
    expect((await readResult(join(dir, 'result.json'), { body: join(dir, 'body.md') })).problem).toBe(
      `The result is over ${RESULT_BYTES} bytes.`,
    );
  });

  it('takes a folder for no file', async () => {
    const dir = out();
    writeFileSync(join(dir, 'result.json'), '{}');
    mkdirSync(join(dir, 'body.md'));
    expect(await readResult(join(dir, 'result.json'), { body: join(dir, 'body.md') })).toEqual({
      problem: 'The agent wrote no body.',
    });
  });
});

describe('a step’s result files', () => {
  const step = { agent: 'describer', repository: 'https://github.com/o/r.git', commit: 'c'.repeat(40) };
  const of = (fields: object) => () =>
    stepFrom({ RUNNER_STEP: JSON.stringify({ ...step, prompt: 'Go.', maxTurns: 1, ...fields }) });

  it('are part of its result, and few', () => {
    expect(of({ result: true, resultFiles: { body: 'description.md' } })().resultFiles).toEqual({
      body: 'description.md',
    });
    expect(of({ resultFiles: { body: 'description.md' } })).toThrow('part of its result');
    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((f) => [f, `${f}.md`]));
    expect(of({ result: true, resultFiles: many })).toThrow('at most 4 files');
  });
});

describe('a runner’s skills', () => {
  /** What the model was offered on the step's last call: its tools, and the skills its context lists. */
  function offered() {
    const call = model?.requests.filter((r) => r.path.startsWith('/v1/messages')).at(-1)?.body as {
      tools: { name: string }[];
      messages: unknown[];
    };
    const context = JSON.stringify(call.messages);
    return { tools: call.tools.map((t) => t.name), context };
  }

  it('gives a step the skill it names, alone, from the runner’s plugin, and tells it to use it', async () => {
    const handback = await run([{ tool: 'Skill', input: { skill: 'factory:visual-pr' } }, { text: 'Read it.' }], {
      skill: 'visual-pr',
    });
    expect(handback.ending).toBe('finished');
    const { tools, context } = offered();
    expect(tools).toContain('Skill');
    expect(context).toContain('- factory:visual-pr:');
    // Claude Code's own skills are not offered: only the one the step names.
    expect(context).not.toMatch(/- (?!factory:visual-pr)[a-z-]+(:[a-z-]+)?: /);
    // Using it loads the vendored skill's text.
    expect(context).toContain('Write the description of a pull request');
    const system = JSON.stringify(model?.requests.find((r) => r.path.startsWith('/v1/messages'))?.body);
    expect(system).toContain('Use the factory:visual-pr skill for this step.');
  });

  it('gives a step that names no skill no skills, and no tool to load one', async () => {
    await run([{ text: 'Nothing to do.' }]);
    const { tools, context } = offered();
    expect(tools).not.toContain('Skill');
    expect(context).not.toContain('visual-pr');
  });

  it('refuses a skill the runner does not hold', async () => {
    await expect(run([{ text: 'Done.' }], { skill: 'not-here' })).rejects.toThrow(
      'The runner holds no skill called not-here.',
    );
  });
});
