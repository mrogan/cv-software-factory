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
 * A step that reads a change (the reviewer's) names its base as well as its commit. Both are fetched with the commits
 * between them and none before, and the base is the checkout's branch `base`: `git diff base` is the change,
 * `git log base..HEAD` its commits, every round's, and `git show base:<path>` a file as it was before it, such as the
 * rules a review holds the change to.
 *
 * A dry run's pull request has commits GitHub never had: the step names the real commit they went on, and each of
 * them as a patch and its message, and they are committed here on it, after the base is fetched, as the pull
 * request's own commits.
 *
 * A seed is committed by a fixed author, under a fixed message, at a fixed time, so the same seed on the same commit
 * makes the same base every time: its sha can reach the agent's prompt (Claude Code shows it the latest commits), and
 * the gateway's cassettes replay only what is sent again exactly. The message says nothing of what the seed is, since
 * real work never comes with such a hint. For the same reason every file of the checkout is given that time too,
 * since the agent's searches list files by when they changed.
 */
import { execFile } from 'node:child_process';
import { lutimes, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { git, gitInput, gitWith } from './git.ts';
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
  await git(dir, 'fetch', '--quiet', '--depth=1', step.repository, step.commit);
  await git(dir, 'checkout', '--quiet', '--detach', step.commit);
  log(`checked out ${step.commit.slice(0, 7)} from ${step.repository}`);
  if (step.base) {
    await fetchBase(dir, step.repository, step.commit, step.base);
    log(`named its base, ${step.base.slice(0, 7)}, with the commits since`);
  }
  for (const { message, patch } of step.commits ?? []) {
    await commitPatch(dir, patch, { message, author: 'dry-run' });
  }
  if (step.commits?.length) log(`made the dry run's ${step.commits.length} commits on it`);
  if (step.seed) {
    await commitPatch(dir, step.seed, { message: SEED_MESSAGE, author: 'runner' });
    log('applied the seed, and committed it as the base');
  } else {
    await settleTimes(dir);
  }
  await exec('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--reporter=silent'], {
    cwd: dir,
    env: { ...env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  log('installed the dependencies');
}

/** Times the history between a step's commit and its base is deepened before the prepare step gives up. */
const DEEPENINGS = 10;

/**
 * Fetches a step's base, names it `base`, and deepens the commit's history until it meets it, so `git log base..HEAD`
 * lists every commit of the change and nothing older: the coder's commit of each round, and any merge of main. Both
 * start without their history; each deepening doubles what is fetched, and deepens the base's as well, so a commit
 * of main that the change's history reaches is known as one of the base's too. Commits the change has but the base
 * has not are complete once none of them is a shallow root.
 */
async function fetchBase(dir: string, repository: string, commit: string, base: string): Promise<void> {
  await git(dir, 'fetch', '--quiet', '--depth=1', repository, base);
  await git(dir, 'branch', 'base', base);
  for (let deepen = 1, tries = 0; tries < DEEPENINGS; deepen *= 2, tries++) {
    const shallow = new Set(await shallowRoots(dir));
    const since = (await git(dir, 'rev-list', 'HEAD', '--not', 'base')).split('\n').filter(Boolean);
    if (!since.some((sha) => shallow.has(sha))) return;
    await git(dir, 'fetch', '--quiet', `--deepen=${deepen}`, repository, commit);
  }
}

/** The shallow roots of a checkout, from the file git keeps them in: none when the file is not there. */
async function shallowRoots(dir: string): Promise<string[]> {
  const file = (await git(dir, 'rev-parse', '--git-path', 'shallow')).trim();
  const text = await readFile(join(dir, file), 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

/**
 * Commits a patch on the checkout's head, by `author`, at the seed's time and under `message`, and gives every file
 * that time: the same patch on the same commit makes the same sha on every run. The patch reaches `git apply` on its
 * standard input, so no file is written for it.
 */
export async function commitPatch(
  dir: string,
  patch: string,
  { message, author }: { message: string; author: string },
): Promise<void> {
  await gitInput(patch, dir, 'apply', '--whitespace=nowarn', '-');
  await git(dir, 'add', '--all');
  await gitWith(
    { GIT_AUTHOR_DATE: SEED_DATE, GIT_COMMITTER_DATE: SEED_DATE },
    dir,
    '-c',
    `user.name=${author}`,
    '-c',
    `user.email=${author}@factory.invalid`,
    'commit',
    '--quiet',
    '--message',
    message,
  );
  await settleTimes(dir);
}

/**
 * Gives every file of the checkout the same time, the seed's. A checkout's files take the time they were written,
 * and Claude Code lists what it finds by when each file last changed, so without this the same search answers in
 * another order on every run and a replay ends there. A link is given the time itself, not its target, which may be
 * outside the checkout or nowhere.
 */
async function settleTimes(dir: string): Promise<void> {
  const at = new Date(SEED_DATE);
  const files = (await git(dir, 'ls-files', '-z')).split('\0').filter(Boolean);
  await Promise.all(files.map((file) => lutimes(join(dir, file), at, at)));
}
