/**
 * Keeps the App's pull requests current with main. The ruleset requires a branch to be up to date before it merges,
 * so each merge leaves every other open pull request behind; a person would click "Update branch".
 *
 * The App updates only its own pull requests, and only those nobody has approved yet. Updating is a push, and a push
 * after Martin's approval would make it stale (the ruleset asks for approval after the last push), so once he has
 * approved, the branch is his to update or merge. Each update runs the checks again, so a pull request is current
 * and checked by the time he looks at it.
 *
 * A deploy pull request is left to the deploy watch, which keeps its branch one commit on main's head (`deploys.ts`).
 * Two writers to one branch raced: an update GitHub had accepted but not yet made met the deploy watch's forced move,
 * and GitHub closed the pull request, as the App.
 */
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Actions } from './actions.ts';
import type { GitHub } from './client.ts';
import { GitHubError } from './client.ts';
import { DEPLOYS } from './deploys.ts';
import type { Watch } from './poller.ts';

/** How the App appears as a pull request's author. */
export const APP_LOGIN = 'mrogan-software-factory[bot]';

const OPEN = z.array(
  z.object({
    number: z.number().int().positive(),
    // GitHub gives a deleted account as null.
    user: z.object({ login: z.string() }).nullable(),
    head: z.object({ ref: z.string(), sha: z.string() }),
  }),
);
const COMPARISON = z.object({ behind_by: z.number().int().nonnegative() });
const REVIEWS = z.array(z.object({ state: z.string() }));

export function currentWatch(github: GitHub, actions: Actions, repo: string, log: Logger): Watch {
  // Heads already tried: updated, or found to conflict with main. A dry run, which moves nothing, records each update
  // once, and a conflict is reported once; a new push is a new head, and tried afresh.
  const updated = new Set<string>();
  return async () => {
    const { body: open } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=open&sort=created&direction=asc&per_page=50`,
      OPEN,
    );
    const deploys = new Set(DEPLOYS.filter((t) => t.repo === repo).map((t) => t.branch));
    for (const pr of open.filter((p) => p.user?.login === APP_LOGIN && !deploys.has(p.head.ref))) {
      if (updated.has(pr.head.sha)) continue;
      const { body: comparison } = await github.poll(repo, `/repos/${repo}/compare/main...${pr.head.sha}`, COMPARISON);
      if (comparison.behind_by === 0) continue;
      const { body: reviews } = await github.poll(
        repo,
        `/repos/${repo}/pulls/${pr.number}/reviews?per_page=100`,
        REVIEWS,
      );
      if (reviews.some((r) => r.state === 'APPROVED')) continue;
      try {
        await actions.updateBranch(repo, pr.number, pr.head.sha);
        updated.add(pr.head.sha);
        log.info({ repo, number: pr.number, behind: comparison.behind_by }, 'brought a pull request up to date');
      } catch (error) {
        // A conflict, or a head that moved since it was read: the next poll sees the new state.
        if (!(error instanceof GitHubError && error.kind === 'conflict')) throw error;
        updated.add(pr.head.sha);
        log.warn({ repo, number: pr.number, message: error.message }, 'could not bring a pull request up to date');
      }
    }
  };
}
