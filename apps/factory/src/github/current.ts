/**
 * Keeps the App's pull requests current with main. The ruleset requires a branch to be up to date before it merges,
 * so each merge leaves every other open pull request behind; a person would click "Update branch".
 *
 * The App updates only its own pull requests, and only those nobody has approved yet. Updating is a push, and a push
 * after Martin's approval would make it stale (the ruleset asks for approval after the last push), so once he has
 * approved, the branch is his to update or merge. Each update runs the checks again, so a pull request is current
 * and checked by the time he looks at it.
 */
import type { Logger } from 'pino';
import type { Actions } from './actions.ts';
import type { GitHub } from './client.ts';
import { GitHubError } from './client.ts';
import type { Watch } from './poller.ts';

/** How the App appears as a pull request's author. */
export const APP_LOGIN = 'mrogan-software-factory[bot]';

interface OpenPullRequest {
  number: number;
  user: { login: string };
  head: { sha: string; ref: string };
}

export function currentWatch(github: GitHub, actions: Actions, repo: string, log: Logger): Watch {
  // Heads already updated from, so a dry run, which moves nothing, records each update once.
  const updated = new Set<string>();
  return async () => {
    const { body: open } = await github.poll<OpenPullRequest[]>(
      repo,
      `/repos/${repo}/pulls?state=open&sort=created&direction=asc&per_page=50`,
    );
    for (const pr of open.filter((p) => p.user.login === APP_LOGIN)) {
      const { body: comparison } = await github.poll<{ behind_by: number }>(
        repo,
        `/repos/${repo}/compare/main...${pr.head.sha}`,
      );
      if (comparison.behind_by === 0 || updated.has(pr.head.sha)) continue;
      const { body: reviews } = await github.poll<{ state: string }[]>(
        repo,
        `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
      );
      if (reviews.some((r) => r.state === 'APPROVED')) continue;
      try {
        await actions.updateBranch(repo, pr.number, pr.head.sha);
        updated.add(pr.head.sha);
        log.info({ repo, number: pr.number, behind: comparison.behind_by }, 'brought a pull request up to date');
      } catch (error) {
        // A conflict, or a head that moved since it was read: the next poll sees the new state.
        if (!(error instanceof GitHubError && error.kind === 'conflict')) throw error;
        log.warn({ repo, number: pr.number, message: error.message }, 'could not bring a pull request up to date');
      }
    }
  };
}
