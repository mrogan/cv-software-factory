/**
 * The prepare step, in the prepare pod: the one of a runner's two pods that may reach GitHub and the npm registry.
 * It checks out the step's commit onto the job's volume and installs its dependencies there, so the agent pod,
 * which reaches nothing but the gateway and the handback, finds everything it needs.
 *
 * The volume is the agent's too, so the agent may have left anything there. This pod has the internet, so it runs
 * nothing from the volume: each step it deletes the checkout and makes a fresh one at the commit the line names (the
 * branch's head on GitHub), with git, pnpm and pnpm's store, home and settings of its own (`PREPARE`, an empty
 * folder each time). No lifecycle script or pnpmfile runs. The agent's session, in its own home on the volume, stays,
 * so a later round resumes it.
 */
import { execFile } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git } from './git.ts';
import { repoDir, stepFrom } from './step.ts';

const exec = promisify(execFile);

export async function prepare(env = process.env, log = (line: string) => console.log(line)): Promise<void> {
  const step = stepFrom(env);
  const dir = repoDir(env);
  // Only `rm`, which reads nothing it deletes, touches what the agent left.
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '--quiet');
  // A commit by its sha, and nothing else of the repository's history.
  await git(dir, 'fetch', '--quiet', '--depth=1', step.repository, step.commit);
  await git(dir, 'checkout', '--quiet', '--detach', 'FETCH_HEAD');
  log(`checked out ${step.commit.slice(0, 7)} from ${step.repository}`);
  if (step.seed) {
    const seed = join(env.PREPARE ?? '/tmp', 'seed.patch');
    await writeFile(seed, step.seed);
    await git(dir, 'apply', '--whitespace=nowarn', seed);
    await git(dir, 'add', '--all');
    await git(
      dir,
      '-c',
      'user.name=runner',
      '-c',
      'user.email=runner@factory.invalid',
      'commit',
      '--quiet',
      '--message',
      'The smoke run’s seeded defect',
    );
    log('applied the seed, and committed it as the base');
  }
  await exec('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--reporter=silent'], {
    cwd: dir,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  log('installed the dependencies');
}
