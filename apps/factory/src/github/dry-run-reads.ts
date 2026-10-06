/**
 * What a dry run reads back: the branches, commits and pull requests it would have made, answered as GitHub would
 * have answered for them, and everything else read from GitHub as it is. Without this, a line in `dry-run` reads a
 * pull request numbered past a billion, which GitHub has never heard of, and waits at Gates for ever.
 *
 * A pull request the dry run opened reads as open, its head the last commit it would have pushed. Each commit it
 * would have made has every check main's ruleset requires, each passing once `checksAfterMs` has passed since the
 * commit; and the pull request reads as merged, by the App, once `mergeAfterMs` has passed since it was opened, so
 * the work item ends and a soak goes round. Nothing ran: each check's title says so, and the gate's summary carries
 * it. A comparison of a commit the dry run made is taken against the real commit its first one went on, from the
 * files as they really are there and as the dry run left them.
 *
 * Its memory is the dry run's (`DryRunActions`), and lasts as long as the worker: a worker started again has
 * forgotten the pull requests it opened, and GitHub answers that it has none at those numbers.
 */
import { createHash } from 'node:crypto';
import { structuredPatch } from 'diff';
import type { DryRunActions, DryRunPull } from './actions.ts';
import { APP_LOGIN } from './current.ts';
import type { CheckRun, Comparison, PullRequestState, Reads } from './reads.ts';

export interface DryRunTimes {
  /** How long after a commit the dry run's checks on it pass. */
  checksAfterMs: number;
  /** How long after a pull request opens the dry run merges it. */
  mergeAfterMs: number;
}

/** The title on each of the dry run's checks, which the gate's summary carries. */
export const DRY_RUN_CHECK_TITLE = 'Passed in a dry run: nothing ran';

/** The check a dry run reports when the base branch requires none, so the gates still finish. */
const NO_REQUIRED = ['Dry run'];

/** A sha for what never existed, from what it stands for: the same every time it is asked for. */
const shaFor = (what: string) => createHash('sha1').update(`dry run: ${what}`).digest('hex');

export class DryRunReads implements Reads {
  readonly #made: DryRunActions;
  readonly #live: Reads;
  readonly #times: DryRunTimes;
  readonly #now: () => Date;

  constructor(made: DryRunActions, live: Reads, times: DryRunTimes, now: () => Date = () => new Date()) {
    this.#made = made;
    this.#live = live;
    this.#times = times;
    this.#now = now;
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestState> {
    const pull = this.#made.pullRequestMade(number);
    return pull?.repo === repo ? this.#state(pull) : this.#live.pullRequest(repo, number);
  }

  async pullRequestFrom(repo: string, branch: string): Promise<PullRequestState | null> {
    const pull = this.#made.pullRequestsMade().find((p) => p.repo === repo && p.head === branch);
    if (!pull) return this.#live.pullRequestFrom(repo, branch);
    const state = this.#state(pull);
    return state.state === 'open' ? state : null;
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    const commit = this.#made.commitMade(sha);
    if (!commit) return this.#live.checkRuns(repo, sha);
    const required = await this.#live.requiredChecks(repo, 'main');
    const done = this.#now().getTime() - commit.at.getTime() >= this.#times.checksAfterMs;
    const startedAt = commit.at.toISOString();
    const completedAt = new Date(commit.at.getTime() + this.#times.checksAfterMs).toISOString();
    return (required.length ? required : NO_REQUIRED).map((name, index) => ({
      id: Number.parseInt(sha.slice(0, 8), 16) * 100 + index + 1,
      name,
      status: done ? 'completed' : 'in_progress',
      conclusion: done ? 'success' : null,
      app: 'dry-run',
      startedAt,
      completedAt: done ? completedAt : null,
      title: DRY_RUN_CHECK_TITLE,
    }));
  }

  requiredChecks(repo: string, branch: string): Promise<string[]> {
    return this.#live.requiredChecks(repo, branch);
  }

  async head(repo: string, branch: string): Promise<string> {
    return this.#made.branchMade(repo, branch) ?? this.#live.head(repo, branch);
  }

  /** At a commit the dry run made, the paths protected where its first commit went: it never changes CODEOWNERS. */
  protectedPaths(repo: string, ref: string): Promise<string[]> {
    return this.#live.protectedPaths(repo, this.#made.rootOf(ref));
  }

  async comparison(repo: string, base: string, head: string): Promise<Comparison> {
    if (!this.#made.commitMade(head)) return this.#live.comparison(repo, base, head);
    const root = this.#made.rootOf(head);
    // Every path a commit of the chain changed, as the latest of them left it.
    const changed = new Set<string>();
    for (let at = head, made = this.#made.commitMade(at); made; at = made.parent, made = this.#made.commitMade(at)) {
      for (const path of made.files.keys()) changed.add(path);
    }
    const files: Comparison['files'] = [];
    for (const path of [...changed].sort()) {
      const [before, after] = await Promise.all([this.#made.file(repo, path, root), this.#made.file(repo, path, head)]);
      if (before === after) continue;
      files.push({ path, ...hunks(path, before ?? '', after ?? '') });
    }
    return { mergeBase: root, files };
  }

  #state(pull: DryRunPull): PullRequestState {
    const sha = this.#made.branchMade(pull.repo, pull.head) ?? shaFor(`${pull.repo}#${pull.number} head`);
    const merged = this.#now().getTime() - pull.openedAt.getTime() >= this.#times.mergeAfterMs;
    return {
      number: pull.number,
      state: merged ? 'closed' : 'open',
      merged,
      mergeCommit: merged ? shaFor(`${pull.repo}#${pull.number} merged`) : null,
      // The dry run stands in for the merge, so it is the App's, never Martin's.
      mergedBy: merged ? APP_LOGIN : null,
      head: { ref: pull.head, sha },
      base: { ref: pull.base, sha: this.#made.rootOf(sha) },
      draft: pull.draft,
      nodeId: pull.nodeId,
    };
  }
}

/** A file's change as GitHub's comparison shows it: its hunks, and the lines added and removed. */
function hunks(path: string, before: string, after: string): { patch: string; added: number; removed: number } {
  const { hunks: parts } = structuredPatch(path, path, before, after, '', '', { context: 3 });
  const lines = parts.flatMap((h) => h.lines);
  return {
    patch: parts
      .map((h) => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines].join('\n'))
      .join('\n'),
    added: lines.filter((line) => line.startsWith('+')).length,
    removed: lines.filter((line) => line.startsWith('-')).length,
  };
}
