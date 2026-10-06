import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { attempt } from '../src/agent.ts';
import { prepare, SEED_MESSAGE } from '../src/prepare.ts';

/** A repository the prepare step can fetch from by path, with a package that needs nothing installed. */
function origin(): { url: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'origin-'));
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    });
  git('init', '--quiet');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'shop', private: true }));
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n",
  );
  writeFileSync(join(dir, 'count.ts'), 'export const count = 1;\n');
  // A link to nothing, which a checkout may hold.
  symlinkSync('nowhere.ts', join(dir, 'gone.ts'));
  git('add', '.');
  git('commit', '--quiet', '--message', 'base');
  // Fetching a commit by its sha, as GitHub allows.
  git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
  return { url: `file://${dir}`, commit: git('rev-parse', 'HEAD').trim() };
}

describe('the prepare step', () => {
  it('starts from a fresh checkout each time, whatever the agent left behind, with the seed as the same base', async () => {
    const { url, commit } = origin();
    const work = mkdtempSync(join(tmpdir(), 'work-'));
    const own = mkdtempSync(join(tmpdir(), 'prepare-'));
    mkdirSync(join(own, 'home'));
    const env = {
      ...process.env,
      WORK: work,
      PREPARE: own,
      HOME: join(own, 'home'),
      npm_config_store_dir: join(own, 'store'),
      RUNNER_STEP: JSON.stringify({
        agent: 'coder',
        repository: url,
        commit,
        prompt: 'Fix it.',
        maxTurns: 5,
        seed: 'diff --git a/seeded.ts b/seeded.ts\nnew file mode 100644\n--- /dev/null\n+++ b/seeded.ts\n@@ -0,0 +1 @@\n+export const seeded = true;\n',
      }),
    };
    await prepare(env, () => {});
    const repo = join(work, 'repo');
    expect(readFileSync(join(repo, 'seeded.ts'), 'utf-8')).toBe('export const seeded = true;\n');
    const base = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf-8' }).trim();
    const first = base();
    // Committed at a fixed time, so a later run makes the same sha.
    const dates = execFileSync('git', ['log', '-1', '--format=%aI %cI'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(dates).toBe('2026-01-01T00:00:00Z 2026-01-01T00:00:00Z');
    // Its message, which the agent sees, says nothing of what the seed is.
    const message = execFileSync('git', ['log', '-1', '--format=%s'], { cwd: repo, encoding: 'utf-8' }).trim();
    expect(message).toBe(SEED_MESSAGE);
    // Every file has that time too, so the agent's searches, which list files by when they changed, list them alike.
    for (const file of ['count.ts', 'seeded.ts']) {
      expect(statSync(join(repo, file)).mtime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }
    expect(lstatSync(join(repo, 'gone.ts')).mtime.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    // What an agent might plant for the next prepare: a hook, a pnpmfile, a stray file.
    writeFileSync(join(repo, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\ntouch /tmp/planted\n', { mode: 0o755 });
    writeFileSync(join(repo, '.pnpmfile.cjs'), 'throw new Error("planted")');
    writeFileSync(join(repo, 'stray.ts'), 'x');
    await prepare(env, () => {});
    expect(existsSync(join(repo, '.pnpmfile.cjs'))).toBe(false);
    expect(existsSync(join(repo, 'stray.ts'))).toBe(false);
    expect(existsSync(join(repo, '.git', 'hooks', 'post-checkout'))).toBe(false);
    expect(base()).toBe(first);
  }, 60_000);
});

describe('the fence check', () => {
  it('takes a refused connection for a block, and a name that does not resolve for nothing', async () => {
    // Nothing listens on this port (fetch refuses some low ports outright, so it is not one of those).
    expect(await attempt('http://127.0.0.1:49151')).toBe('blocked');
    expect(await attempt('http://no-such-host.invalid')).toBe('unclear');
  });
});
