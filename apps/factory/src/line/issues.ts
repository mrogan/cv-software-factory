/**
 * Closing a work item's issue in the app's repository, as the line and its flag pass both do: through the GitHub
 * worker, as not planned or completed, with a comment saying why. One GitHub no longer has, or that the App may no
 * longer change, is left as it is, and logged: asking again would not help, and the work item closes all the same.
 * Any other failure is thrown, for the caller to try again later; the GitHub worker never says a comment twice.
 */
import type { Logger } from 'pino';
import type { ActionArgs } from '../github/server.ts';
import { issueGone } from '../github/worker-client.ts';
import type { GitHubPort } from './worker.ts';

export async function closeIssue(
  github: Pick<GitHubPort, 'act'>,
  repo: string,
  args: ActionArgs['closeIssue'],
  workItem: string,
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  await github.act('closeIssue', repo, args, { workItem }).catch((error: unknown) => {
    if (!issueGone(error)) throw error;
    log.warn({ workItem, issue: args.number, err: error }, 'the issue cannot be closed');
  });
}
