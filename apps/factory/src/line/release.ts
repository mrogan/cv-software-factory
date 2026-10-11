/**
 * The line's watch of the app's releases (`release/watch.ts` decides; this reads and appends). Each pass reads the
 * Rollout and its AnalysisRuns, the release events already recorded for the versions they name, and, only when there is
 * something new to record, what it needs for it:
 *
 * - for a release starting, the new image's commit and signature, through the GitHub worker (the line has no way to
 *   GHCR), and the work items it carries: those whose fixes merged between the commit the stable version runs and the
 *   new image's, as the deploy pull request lists them. For a version found live, each merged work item no release has
 *   carried whose fix is already in it. A commit GitHub never had (a dry run's) is in neither.
 * - for each step, each version's figures from Prometheus; for a rollback, the series of each failed measure.
 *
 * A figure or series it could not read is left out, and the step or rollback recorded without it.
 *
 * In a dry run (`LINE_MODE=dry-run`), a work item whose merge the dry run made, which never shipped, is released by the
 * dry run's word instead: started a while after its merge, stepped, and promoted, each marked `dryRun`, so a soak goes
 * round. With `only`, the line watches no release of the app, which could carry other work items, and answers for the
 * dry run's release of that work item alone.
 *
 * It changes nothing in Kubernetes: the line may read the Rollout and its runs, and nothing else there.
 */
import { type RawEvent, RELEASE_TYPES, upcast } from '@software-factory/events';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { Prometheus } from '../clients/prometheus.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { DEPLOYS } from '../github/deploys.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import { figuresAt, hashesOf, type RolloutRef, readRollout, seriesOf } from '../release/read.ts';
import {
  dryRunEvents,
  dryRunRelease,
  type Facts,
  type Figures,
  measuresOf,
  type Needs,
  named,
  type Observed,
  observe,
  recordedFrom,
  releaseEvents,
  releaseNeeds,
  type Series,
  type Start,
  startOf,
  type Target,
} from '../release/watch.ts';
import type { Kube } from '../runners/kube.ts';
import { asEvent, type Draft } from './gates.ts';
import { fold, type LineEvent } from './machine.ts';
import type { GitHubPort } from './worker.ts';

/** Where the line reads the app's releases. */
export interface ReleaseWatchOptions {
  kube: Kube;
  rollout: RolloutRef;
  prometheus: Prometheus;
}

export interface ReleasesOptions {
  sql: Sql;
  events: { append(events: ReturnType<typeof asEvent>[]): Promise<unknown> };
  github: GitHubPort;
  repo: string;
  log: Logger;
  now: () => Date;
  /** The Rollout to watch, or null to watch none. */
  watch: ReleaseWatchOptions | null;
  /** Whether the line runs a dry run, and answers for its merges' releases. */
  dryRun: boolean;
  /** How long a dry run's release takes over each of its moves. */
  dryRunEveryMs: number;
  only: string | null;
}

/** A merged work item no closing has ended: its latest merge, and where its events put it. */
interface Merged {
  workItem: string;
  number: number;
  commit: string;
  at: string;
  /** Whether a release has carried it since its latest merge, and not rolled back. */
  released: boolean;
}

export class Releases {
  readonly #o: ReleasesOptions;

  constructor(options: ReleasesOptions) {
    this.#o = options;
  }

  /** One pass: the app's release, then a dry run's. A failure in one leaves the other to go on. */
  async pass(): Promise<void> {
    const { watch, dryRun, only, log } = this.#o;
    if (watch && only === null) {
      await this.#watch(watch).catch((error: unknown) =>
        log.warn({ err: errorOf(error) }, 'could not read the app’s release'),
      );
    }
    if (dryRun) {
      await this.#dryRun().catch((error: unknown) =>
        log.warn({ err: errorOf(error) }, 'could not answer for a dry run’s release'),
      );
    }
  }

  async #watch({ kube, rollout, prometheus }: ReleaseWatchOptions): Promise<void> {
    const { log } = this.#o;
    const read = await readRollout(kube, rollout);
    if (!read) {
      log.debug(rollout, 'no Rollout to watch');
      return;
    }
    const o = observe(read.rollout, read.runs);
    const recorded = recordedFrom(await this.#recorded(named(o)));
    const needs = releaseNeeds(o, recorded);
    const start = needs.start && (await this.#start(needs.start));
    const lastPromoted = needs.start && (await this.#lastPromoted());
    const figures = new Map<string, Figures>();
    for (const run of needs.steps) {
      const hashes = hashesOf(run);
      const at = run.status.completedAt;
      if (!hashes || !at) continue;
      try {
        figures.set(run.metadata.name, await figuresAt(prometheus, hashes, new Date(at)));
      } catch (error) {
        log.warn({ run: run.metadata.name, err: errorOf(error) }, 'could not read a step’s figures');
      }
    }
    const series = new Map<string, Series>();
    for (const run of needs.failures) {
      const hashes = hashesOf(run);
      const at = run.status.completedAt;
      const from = startOf(o, hashes?.canary ?? '');
      if (!hashes || !at || !from) continue;
      for (const measure of measuresOf(run).filter((m) => m.phase === 'failed')) {
        try {
          const drawn = await seriesOf(prometheus, measure.name, hashes, new Date(from), new Date(at));
          if (drawn) series.set(`${run.metadata.name}/${measure.name}`, drawn);
        } catch (error) {
          log.warn({ run: run.metadata.name, measure: measure.name, err: errorOf(error) }, 'could not draw a series');
        }
      }
    }
    const facts: Facts = {
      ...(start ? { start } : {}),
      ...(lastPromoted ? { lastPromoted } : {}),
      figures,
      series,
    };
    await this.#append(releaseEvents(o, recorded, facts), o);
  }

  /** What a release starting needs read: its image's commit and signature, and the work items it carries. */
  async #start(start: NonNullable<Needs['start']>): Promise<Start | undefined> {
    const { github, repo, log } = this.#o;
    const image = DEPLOYS.find((t) => t.repo === repo && !t.what)?.images[0]?.image;
    if (!image) return undefined;
    const commit = await github.read('imageRevision', repo, { image, digest: start.digest });
    if (!commit) {
      log.warn({ release: start.release, digest: start.digest }, 'the release’s image names no commit: not recorded');
      return undefined;
    }
    const { signed } = await github.read('imageSigned', repo, { image, digest: start.digest });
    const carries = start.found ? await this.#foundIn(commit) : await this.#between(start.previous?.commit, commit);
    return { commit, signed, carries };
  }

  /** The work items whose fixes merged after `base` and up to `head`, not closed, in the order they merged. */
  async #between(base: string | undefined, head: string): Promise<string[]> {
    const { sql, log } = this.#o;
    if (!base) return [];
    const range = await this.#commits(base, head);
    if (!range?.commits.length) return [];
    if (range.total > range.commits.length) {
      log.warn({ base, head, total: range.total }, 'the release runs more commits than the line reads');
    }
    // Each work item's latest merge: one sent back after a merge is carried by the release of its latest fix only.
    const rows = await sql<{ work_item: string }[]>`
      select work_item from (
        select distinct on (m.work_item) m.work_item, m.seq, m.payload->>'commit' as commit from events m
        where m.type = 'pull-request.merged'
          and not exists (select 1 from events c where c.work_item = m.work_item and c.type = 'work-item.closed')
        order by m.work_item, m.seq desc
      ) latest
      where commit in ${sql(range.commits)}
      order by seq`;
    return rows.map((row) => row.work_item);
  }

  /** Every merged work item no release has carried, not a dry run's, whose fix is already in `commit`. */
  async #foundIn(commit: string): Promise<string[]> {
    const candidates = (await this.#merged()).filter((item) => !item.released && item.number < DRY_RUN_NUMBERS_FROM);
    const found = await Promise.all(
      candidates.map(async (item) => {
        const ancestry = await this.#commits(item.commit, commit);
        return ancestry?.status === 'ahead' || ancestry?.status === 'identical';
      }),
    );
    return candidates.filter((_, i) => found[i]).map((item) => item.workItem);
  }

  /** The commits from `base` to `head`, or undefined when GitHub has never had one of them. */
  async #commits(base: string, head: string) {
    try {
      return await this.#o.github.read('commits', this.#o.repo, { base, head });
    } catch (error) {
      if (error instanceof GitHubWorkerError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** A dry run's merges, each released by its word: what is due of each release and not recorded. */
  async #dryRun(): Promise<void> {
    const { only, now, dryRunEveryMs } = this.#o;
    const merged = (await this.#merged()).filter(
      (item) => item.number >= DRY_RUN_NUMBERS_FROM && (only === null || item.workItem === only),
    );
    if (!merged.length) return;
    const recorded = recordedFrom(await this.#recorded(merged.map((item) => dryRunRelease(item.commit))));
    let previous: string | undefined;
    const drafts = new Map<Target, Draft[]>();
    for (const item of merged) {
      const record = recorded.get(dryRunRelease(item.commit))?.get(item.workItem);
      if (record?.ended === 'promoted' || (item.released && !record)) continue;
      // The version it would have replaced: the last that shipped, or before any, main as it is.
      previous ??=
        (await this.#lastPromoted()) ?? (await this.#o.github.read('head', this.#o.repo, { branch: 'main' }));
      const due = dryRunEvents(item, previous, record, now(), dryRunEveryMs);
      if (due.length) drafts.set(item.workItem, due);
    }
    await this.#append(drafts);
  }

  /** Every merged work item no closing has ended, with its latest merge and whether a release carries it. */
  async #merged(): Promise<Merged[]> {
    const rows = await this.#o.sql<(RawEvent & { work_item: string; ts: Date })[]>`
      select e.seq, e.work_item, e.ts, e.type, e.version, e.payload from events e
      where e.work_item in (select work_item from events where type = 'pull-request.merged')
        and e.type in ${this.#o.sql(FOLDED)}
        and not exists (select 1 from events c where c.work_item = e.work_item and c.type = 'work-item.closed')
      order by e.seq`;
    const byItem = new Map<string, { events: LineEvent[]; merge?: { number: number; commit: string; at: string } }>();
    for (const row of rows) {
      const read = upcast({ ...row, seq: Number(row.seq) });
      if (!read.ok) continue;
      const item = byItem.get(row.work_item) ?? { events: [] };
      byItem.set(row.work_item, item);
      item.events.push({ type: read.event.type, payload: read.event.payload } as LineEvent);
      if (read.event.type === 'pull-request.merged') {
        const { number, commit } = read.event.payload as { number: number; commit: string };
        item.merge = { number, commit, at: new Date(row.ts).toISOString() };
      }
    }
    return [...byItem.entries()].flatMap(([workItem, { events, merge }]) => {
      const state = fold(events);
      if (!state.merged || !merge) return [];
      const released = state.release !== undefined && !state.release.rolledBack;
      return [{ workItem, ...merge, released }];
    });
  }

  /** The release events recorded for these releases, upcast, in order. */
  async #recorded(names: string[]) {
    if (!names.length) return [];
    const rows = await this.#o.sql<(RawEvent & { work_item: string | null; ts: Date })[]>`
      select seq, work_item, ts, type, version, payload from events
      where type in ${this.#o.sql(RELEASE_TYPES as string[])} and payload->>'release' in ${this.#o.sql(names)}
      order by seq`;
    return rows.flatMap((row) => {
      const read = upcast({ ...row, seq: Number(row.seq) });
      if (!read.ok) return [];
      const { type, payload } = read.event;
      return [{ work_item: row.work_item, ts: new Date(row.ts).toISOString(), type, payload }];
    });
  }

  /** The version the app's last release that shipped made stable. */
  async #lastPromoted(): Promise<string | undefined> {
    const [row] = await this.#o.sql<{ version: string }[]>`
      select payload->>'version' as version from events
      where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true
      order by seq desc limit 1`;
    return row?.version;
  }

  /** Appends every target's drafts at once: a release's events reach all of its work items, or none. */
  async #append(drafts: Map<Target, Draft[]>, o?: Observed): Promise<void> {
    if (!drafts.size) return;
    // A work item closed while its release ran (Martin closed it at Release) takes no more events: the store refuses
    // them, and would refuse the rest of the release's with them.
    const items = [...drafts.keys()].filter((target) => target !== null);
    const closed = items.length
      ? await this.#o.sql<{ work_item: string }[]>`
          select distinct work_item from events where type = 'work-item.closed' and work_item in ${this.#o.sql(items)}`
      : [];
    for (const { work_item } of closed) drafts.delete(work_item);
    if (!drafts.size) return;
    const ts = this.#o.now().toISOString();
    const events = [...drafts].flatMap(([target, list]) => list.map((draft) => asEvent(target, draft, ts)));
    await this.#o.events.append(events);
    this.#o.log.info(
      {
        release: o?.current,
        events: [...drafts].map(([target, list]) => ({ target: target ?? 'line', types: list.map((d) => d.type) })),
      },
      'recorded the app’s release',
    );
  }
}

/** What `fold` needs to say whether a work item merged, and whether a release carries it. */
const FOLDED = ['pull-request.merged', 'work.returned', 'release.started', 'release.promoted', 'release.rolled-back'];

const errorOf = (error: unknown) => ({
  type: (error as Error)?.name ?? 'Error',
  message: (error as Error)?.message ?? String(error),
});
