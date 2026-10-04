/**
 * Polling: how the factory hears from GitHub, which never calls it (the local cluster has no public address, and a
 * webhook receiver would be the first thing on it the internet could reach).
 *
 * A `Poller` runs each of its watches once a minute, one after another. A watch asks GitHub with a conditional
 * request, so an answer that has not changed costs nothing against the rate limit, compares what it sees with what it
 * saw last, and hands each change to whatever waits for it. A watch that fails is logged and tried again next time;
 * it never stops the others.
 */
import type { Logger } from 'pino';
import type { GitHub } from './client.ts';
import type { Registry } from './registry.ts';

export type Watch = () => Promise<void>;

export interface PollerOptions {
  intervalMs: number;
  log: Logger;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', wake, { once: true });
  });

export class Poller {
  readonly #watches = new Map<string, Watch>();
  readonly #intervalMs: number;
  readonly #log: Logger;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  #stopping = new AbortController();
  #running: Promise<void> | undefined;

  constructor({ intervalMs, log, sleep = abortableSleep }: PollerOptions) {
    this.#intervalMs = intervalMs;
    this.#log = log;
    this.#sleep = sleep;
  }

  /** Adds a watch, or replaces the one with the same name. */
  watch(name: string, watch: Watch): void {
    this.#watches.set(name, watch);
  }

  unwatch(name: string): void {
    this.#watches.delete(name);
  }

  get watching(): string[] {
    return [...this.#watches.keys()];
  }

  /** Runs every watch once. */
  async tick(): Promise<void> {
    for (const [name, watch] of [...this.#watches]) {
      if (this.#stopping.signal.aborted) return;
      try {
        await watch();
      } catch (error) {
        this.#log.warn(
          { watch: name, err: { type: (error as Error)?.name, message: (error as Error)?.message } },
          'watch failed',
        );
      }
    }
  }

  start(): void {
    this.#stopping = new AbortController();
    const { signal } = this.#stopping;
    this.#running = (async () => {
      while (!signal.aborted) {
        await this.tick();
        await this.#sleep(this.#intervalMs, signal);
      }
    })();
  }

  /** Finishes the watch in hand, and runs no more. */
  async stop(): Promise<void> {
    this.#stopping.abort();
    await this.#running;
  }
}

/** One check run as the factory cares about it. */
export interface CheckRunState {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** The app that reported it, such as `github-actions` or the factory's own. */
  app: string | undefined;
  detailsUrl: string | null;
}

/**
 * Watches the check runs on one commit, and hands over each run whose status or conclusion has changed since the
 * last poll (every run, the first time).
 */
export function checkRunsWatch(
  github: GitHub,
  repo: string,
  sha: string,
  onChange: (changed: CheckRunState[], all: CheckRunState[]) => void | Promise<void>,
): Watch {
  const seen = new Map<number, string>();
  // Set while a change has not been handed over, because the handler failed: the next poll hands it over again.
  let retry = true;
  return async () => {
    const { changed, body } = await github.poll<{
      check_runs: {
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        app?: { slug?: string };
        details_url: string | null;
      }[];
    }>(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (!changed && !retry) return;
    const all = body.check_runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      app: r.app?.slug,
      detailsUrl: r.details_url,
    }));
    const fresh = all.filter((r) => seen.get(r.id) !== `${r.status}/${r.conclusion}`);
    retry = true;
    if (fresh.length) await onChange(fresh, all);
    for (const r of all) seen.set(r.id, `${r.status}/${r.conclusion}`);
    retry = false;
  };
}

export interface MergedPullRequest {
  number: number;
  title: string;
  author: string;
  head: string;
  mergeCommit: string;
  mergedAt: string;
}

/**
 * Watches a repository's pull requests for merges, and hands over each one merged since the watch began. The newest
 * thirty closed pull requests are enough at a minute's interval: more than that do not merge in a minute here.
 */
export function mergesWatch(
  github: GitHub,
  repo: string,
  since: Date,
  onMerged: (merged: MergedPullRequest) => void | Promise<void>,
): Watch {
  const handed = new Set<number>();
  return async () => {
    // Unchanged answers are filtered again too: a merge whose handler failed last time is handed over again.
    const { body } = await github.poll<
      {
        number: number;
        title: string;
        user: { login: string };
        head: { ref: string };
        merged_at: string | null;
        merge_commit_sha: string | null;
      }[]
    >(repo, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`);
    const merged = body
      .filter((p) => p.merged_at && p.merge_commit_sha && Date.parse(p.merged_at) >= since.getTime())
      .filter((p) => !handed.has(p.number))
      .sort((a, b) => Date.parse(a.merged_at as string) - Date.parse(b.merged_at as string));
    for (const p of merged) {
      await onMerged({
        number: p.number,
        title: p.title,
        author: p.user.login,
        head: p.head.ref,
        mergeCommit: p.merge_commit_sha as string,
        mergedAt: p.merged_at as string,
      });
      handed.add(p.number);
    }
  };
}

/**
 * Watches an image's tags in GHCR, and hands over the full list whenever a tag appears that was not there before
 * (every tag, the first time). The build workflow tags each image with the commit it was built from.
 */
export function imagesWatch(registry: Registry, image: string, onNew: (tags: string[]) => void | Promise<void>): Watch {
  let known: Set<string> | undefined;
  return async () => {
    const tags = await registry.tags(image);
    if (known && tags.every((t) => known?.has(t))) return;
    await onNew(tags);
    known = new Set(tags);
  };
}
