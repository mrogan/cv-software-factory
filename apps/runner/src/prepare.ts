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
 *
 * A seed is committed by a fixed author, under a fixed message, at a fixed time, so the same seed on the same commit
 * makes the same base every time: its sha can reach the agent's prompt (Claude Code shows it the latest commits), and
 * the gateway's cassettes replay only what is sent again exactly. The message says nothing of what the seed is, since
 * real work never comes with such a hint. For the same reason every file of the checkout is given that time too,
 * since the agent's searches list files by when they changed.
 */
import { execFile } from 'node:child_process';
import { lutimes, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, gitWith } from './git.ts';
import { repoDir, stepFrom } from './step.ts';

const exec = promisify(execFile);

/** When every seed is committed. */
const SEED_DATE = '2026-01-01T00:00:00Z';
/** The seed's commit message, which the agent sees among the latest commits: it says nothing of what the seed is. */
export const SEED_MESSAGE = 'chore: the starting point';

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
    await gitWith(
      { GIT_AUTHOR_DATE: SEED_DATE, GIT_COMMITTER_DATE: SEED_DATE },
      dir,
      '-c',
      'user.name=runner',
      '-c',
      'user.email=runner@factory.invalid',
      'commit',
      '--quiet',
      '--message',
      SEED_MESSAGE,
    );
    log('applied the seed, and committed it as the base');
  }
  await settleTimes(dir);
  await exec('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--reporter=silent'], {
    cwd: dir,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  log('installed the dependencies');
}

/**
 * Gives every file of the checkout the same time, the seed's. A checkout's files take the time they were written,
 * and Claude Code lists what it finds by when each file last changed, so without this the same search answers in
 * another order on every run and a replay ends there. A link is given the time itself, not its target, which may be
 * outside the checkout or nowhere.
 */
export async function settleTimes(dir: string): Promise<void> {
  const at = new Date(SEED_DATE);
  const files = (await git(dir, 'ls-files', '-z')).split('\0').filter(Boolean);
  await Promise.all(files.map((file) => lutimes(join(dir, file), at, at)));
}
