/**
 * The prepare step, in the prepare pod: the one of a runner's two pods that may reach GitHub and the npm registry.
 * It checks out the step's commit onto the job's volume and installs its dependencies there, so the agent pod,
 * which reaches nothing but the gateway and the handback, finds everything it needs. A later step of the same work
 * item finds the checkout already there, and only installs again.
 *
 * No lifecycle scripts run: a dependency's install script would run with the network this pod has.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git } from './git.ts';
import { repoDir, stepFrom, work } from './step.ts';

const exec = promisify(execFile);

export async function prepare(env = process.env, log = (line: string) => console.log(line)): Promise<void> {
  const step = stepFrom(env);
  const dir = repoDir(env);
  if (!existsSync(join(dir, '.git'))) {
    await mkdir(dir, { recursive: true });
    await git(dir, 'init', '--quiet');
    // A commit by its sha, and nothing else of the repository's history.
    await git(dir, 'fetch', '--quiet', '--depth=1', step.repository, step.commit);
    await git(dir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
    await git(dir, 'config', 'user.name', 'runner');
    await git(dir, 'config', 'user.email', 'runner@factory.invalid');
    log(`checked out ${step.commit.slice(0, 7)} from ${step.repository}`);
    if (step.seed) {
      const seed = join(work(env), 'seed.patch');
      await writeFile(seed, step.seed);
      await git(dir, 'apply', '--whitespace=nowarn', seed);
      await git(dir, 'add', '--all');
      await git(dir, 'commit', '--quiet', '--message', 'The smoke run’s seeded defect');
      log('applied the seed, and committed it as the base');
    }
  }
  // pnpm, at the version the app's package.json pins, comes through corepack into the volume, as the store does.
  await exec('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--reporter=silent'], {
    cwd: dir,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  log('installed the dependencies');
}
