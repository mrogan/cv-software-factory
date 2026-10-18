import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('a runner pod', () => {
  it('says why its step failed in a last JSON line, naming the job, and ends in failure', () => {
    const { RUNNER_STEP: _, ...env } = process.env;
    const ran = spawnSync(process.execPath, [CLI, 'prepare'], {
      env: { ...env, RUNNER_JOB: 'coder-1001-1-1', RUNNER_WORK_ITEM: '1001' },
      encoding: 'utf-8',
    });
    expect(ran.status).toBe(1);
    const last = JSON.parse(ran.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(last).toMatchObject({
      level: 'error',
      job: 'coder-1001-1-1',
      workItem: '1001',
      pod: 'prepare',
      msg: 'the prepare step failed',
      error: 'RUNNER_STEP is not set: the job says what to do there.',
    });
  });
});
