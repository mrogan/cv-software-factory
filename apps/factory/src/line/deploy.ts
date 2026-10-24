/**
 * The app's deploy pull request, as each work item held for a deploy sees it. After Martin merges a fix, the line
 * holds the work item at Release until a release carries it (`machine.ts`), and the deploy pull request that will carry
 * it is opened by the App's deploy watch (`github/deploys.ts`), once main has a newer signed build. Until it is open
 * and its checks have passed, there is nothing for Martin to merge; so the line records where that pull request stands
 * for each held work item it carries (`deploy.changed`), and the console says what the wait waits for, and links it.
 *
 * Once a minute, beside telling the pull request what it carries, the line reads the watch's open proposal, works out
 * the held work items it carries (`carried`, as the Carries section does), and reads the pull request and the checks on
 * its head through the GitHub worker, judged as the gates are (`judge`): its checks running, all passed, or one that
 * failed; merged; or closed unmerged. A newer build moves the same pull request to a new head, whose checks run again.
 * A work item's record is the latest `deploy.changed` since its hold started; a state that differs is appended, so the
 * decision is the store's, and a line that restarts appends nothing twice.
 *
 * A pull request recorded for a work item that is no longer the proposal (merged and gone, closed, or not known yet to
 * a GitHub worker that restarted) is read by its number, and only what GitHub says of it is recorded: an empty proposal
 * is never taken for a merge or a close. A dry run's deploy pull request, which GitHub never had, is never recorded.
 */
import type { PayloadOf } from '@software-factory/events';
import type { Logger } from 'pino';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import type { DeployProposal } from '../github/deploys.ts';
import type { CheckRun, PullRequestState } from '../github/reads.ts';
import { type Draft, judge, latestRuns } from './gates.ts';
import type { GitHubPort } from './worker.ts';

export type DeployChange = PayloadOf<'deploy.changed'>;

/** Where a deploy pull request stands, from what GitHub says of it and of the checks on its head. */
export function deployState(
  pr: PullRequestState,
  runs: readonly CheckRun[],
  required: readonly string[],
): Pick<DeployChange, 'state' | 'failed'> {
  if (pr.merged) return { state: 'merged' };
  if (pr.state === 'closed') return { state: 'closed' };
  const latest = latestRuns(runs);
  // No check has started on the head yet: GitHub starts them a moment after a push.
  if (latest.size === 0) return { state: 'checking' };
  const { waiting, failed } = judge(latest, required);
  if (waiting) return { state: 'checking' };
  return failed.length ? { state: 'failed', failed: failed.slice(0, 40) } : { state: 'passed' };
}

/**
 * The latest record of a work item's deploy pull request under the hold in force: the last `deploy.changed` since its
 * last `hold.started`. A hold that starts again (after a rollback, say) waits for a deploy of its own.
 */
export function latestDeploy(events: readonly { type: string; payload: unknown }[]): DeployChange | undefined {
  let latest: DeployChange | undefined;
  for (const { type, payload } of events) {
    if (type === 'hold.started') latest = undefined;
    if (type === 'deploy.changed') latest = payload as DeployChange;
  }
  return latest;
}

/** Whether a deploy pull request's record has ended: merged or closed, it changes no more. */
export const settled = (change: DeployChange | undefined) => change?.state === 'merged' || change?.state === 'closed';

const sameChange = (a: DeployChange | undefined, b: DeployChange) =>
  a?.pullRequest === b.pullRequest &&
  a.commit === b.commit &&
  a.state === b.state &&
  (a.failed ?? []).join('\n') === (b.failed ?? []).join('\n');

/** A deploy pull request's change, as its event's summary says it. */
export function deployLine({ pullRequest, state, failed }: DeployChange): string {
  const pr = `Deploy pull request #${pullRequest}`;
  switch (state) {
    case 'checking':
      return `${pr} carries it; its checks are running`;
    case 'passed':
      return `${pr} carries it, and its checks passed: it waits for Martin to merge it`;
    case 'failed':
      return `${pr} carries it, and ${failed?.[0] ?? 'a check'}${(failed?.length ?? 0) > 1 ? ` and ${(failed?.length ?? 0) - 1} more` : ''} failed on it`;
    case 'merged':
      return `${pr}, which carries it, merged: its release starts once Argo CD syncs`;
    case 'closed':
      return `${pr} was closed unmerged: the next build’s carries it`;
  }
}

/** A work item held for a deploy, and its record under that hold. */
export interface HeldForDeploy {
  workItem: string;
  recorded: DeployChange | undefined;
}

export interface DeployContext {
  github: GitHubPort;
  repo: string;
  log: Logger;
  append: (workItem: string, drafts: Draft[]) => Promise<void>;
}

/**
 * Records where the deploy pull request stands for each work item held for a deploy: the proposal's, for each it
 * carries (`carried`, the work items its range carries); else the one recorded, while it has not merged or closed.
 * Each pull request is read once in a pass. A work item whose reads fail is tried again on the next pass.
 */
export async function recordDeploys(
  o: DeployContext,
  proposal: DeployProposal | null,
  carried: ReadonlySet<string>,
  held: readonly HeldForDeploy[],
): Promise<void> {
  const { github, repo, log } = o;
  // A dry run's deploy pull request is one GitHub never had: it carries nothing real.
  const open = proposal && proposal.number < DRY_RUN_NUMBERS_FROM ? proposal.number : undefined;
  const reads = new Map<number, Promise<DeployChange>>();
  let required: Promise<string[]> | undefined;
  const read = (number: number) => {
    let change = reads.get(number);
    if (!change) {
      change = (async () => {
        const pr = await github.read('pullRequest', repo, { number });
        const runs = pr.state === 'open' ? await github.read('checkRuns', repo, { sha: pr.head.sha }) : [];
        required ??= github.read('requiredChecks', repo, { branch: 'main' });
        return { pullRequest: number, commit: pr.head.sha, ...deployState(pr, runs, await required) };
      })();
      // A read that failed is read again on the next pass, not kept.
      change.catch(() => reads.delete(number));
      reads.set(number, change);
    }
    return change;
  };
  for (const { workItem, recorded } of held) {
    try {
      const drafts: Draft[] = [];
      let last = recorded;
      const record = (change: DeployChange) => {
        if (sameChange(last, change)) return;
        drafts.push({ type: 'deploy.changed', actor: 'factory', summary: deployLine(change), payload: change });
        last = change;
      };
      // The pull request recorded, if it is not the open proposal's: merged or closed, as GitHub says, or still open.
      if (recorded && !settled(recorded) && recorded.pullRequest !== (carried.has(workItem) ? open : undefined)) {
        record(await read(recorded.pullRequest));
      }
      if (open !== undefined && carried.has(workItem)) record(await read(open));
      if (drafts.length) {
        await o.append(workItem, drafts);
        log.info(
          { workItem, deploy: drafts.map((d) => (d.payload as DeployChange).pullRequest), state: last?.state },
          'recorded where the deploy pull request stands',
        );
      }
    } catch (error) {
      log.warn({ workItem, err: error }, 'could not read the deploy pull request that carries a held work item');
    }
  }
}
