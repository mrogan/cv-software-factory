/**
 * Releases, by release-please run as a library with the App's token, for each repository: what the release workflow
 * did with GitHub's token before.
 *
 * Each time main moves, it first tags and publishes the release a merged release pull request asks for, then opens
 * or updates the release pull request with the next version and its changelog, from the Conventional Commits since
 * the last release. Both repositories' settings are their own `release-please-config.json` and
 * `.release-please-manifest.json`, read from main.
 *
 * It does not run in a dry run: release-please writes as it goes, and cannot say what it would have done.
 */
import type { Logger } from 'pino';
import { Manifest, GitHub as ReleasePleaseGitHub, setLogger } from 'release-please';
import type { GitHub } from './client.ts';
import type { Watch } from './poller.ts';

export interface ReleaseOutcome {
  releases: { tag: string; url: string }[];
  pullRequests: { number: number; title: string }[];
}

/** One pass of release-please over a repository. */
export async function release(github: GitHub, repo: string): Promise<ReleaseOutcome> {
  const [owner = '', name = ''] = repo.split('/');
  const token = await github.token(repo);
  const connect = async () =>
    Manifest.fromManifest(
      await ReleasePleaseGitHub.create({ owner, repo: name, token, defaultBranch: 'main', apiUrl: github.api }),
      'main',
      'release-please-config.json',
      '.release-please-manifest.json',
    );
  const released = (await (await connect()).createReleases()).filter((r) => r !== undefined);
  // Read again after releasing, as the action does, so the pull request starts from the release just made.
  const opened = (await (await connect()).createPullRequests()).filter((p) => p !== undefined);
  return {
    releases: released.map((r) => ({ tag: r.tagName, url: r.url })),
    pullRequests: opened.map((p) => ({ number: p.number, title: p.title })),
  };
}

/** Runs release-please on a repository each time its main moves. */
export function releaseWatch(github: GitHub, repo: string, log: Logger, run = release): Watch {
  let ran: string | undefined;
  return async () => {
    const { body } = await github.poll<{ object: { sha: string } }>(repo, `/repos/${repo}/git/ref/heads/main`);
    if (ran === body.object.sha) return;
    const outcome = await run(github, repo);
    for (const r of outcome.releases) log.info({ repo, tag: r.tag }, 'released');
    for (const p of outcome.pullRequests) log.info({ repo, number: p.number }, 'release pull request up to date');
    ran = body.object.sha;
  };
}

/** release-please logs a great deal at info; the worker keeps its warnings and errors, and the rest at debug. */
export function quietReleasePlease(log: Logger): void {
  const at =
    (level: 'debug' | 'warn' | 'error') =>
    (...args: unknown[]) =>
      log[level]({ from: 'release-please' }, args.map(String).join(' '));
  setLogger({ error: at('error'), warn: at('warn'), info: at('debug'), debug: at('debug'), trace: at('debug') });
}
