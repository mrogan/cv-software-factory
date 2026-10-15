/**
 * The line's watch of the app's releases (`release/watch.ts` decides; this reads and appends). Each pass reads the
 * Rollout and its AnalysisRuns, the release events already recorded for the versions they name, and, only when there is
 * something new to record, what it needs for it:
 *
 * - for a release starting, the new image's commit and signature, through the GitHub worker (the line has no way to
 *   GHCR), and the work items it carries (`carried`): those whose fixes merged between the commit the last promoted
 *   release runs and the new image's, as the deploy pull request lists them. For a version found live, each merged
 *   work item no release has carried whose fix is already in it. A commit GitHub never had (a dry run's) is in neither.
 * - for each step, each version's figures from Prometheus; for a rollback, the series of each failed measure.
 * - for an abort, who made it: Stop the line, which records the line's stop and then aborts every release in flight,
 *   when the line's last word before the abort is that it stopped, within the minute before; otherwise Martin, by
 *   hand. Argo Rollouts keeps the abort's time to the second, cut short, so a stop recorded within the second after
 *   it counts as before it.
 *
 * A figure or series it could not read is left out, and the step or rollback recorded without it.
 *
 * Each measure that failed a release it recorded is also a signal to triage, from the `canary` sense
 * (`release/signals.ts`), with the routes where the canary did worse, from Prometheus, or for the journeys, the checks
 * that regressed, from the Job's termination message. One whose routes or Job it could not read yet is sent on a
 * later pass, when it can.
 *
 * In a dry run (`LINE_MODE=dry-run`), a work item whose merge the dry run made, which never shipped, is released by the
 * dry run's word instead: started a while after its merge, stepped, and promoted, each marked `dryRun`, so a soak goes
 * round. With `only`, the line records a release only when it carries that work item or none (the line's own events
 * keep the record of what the app runs whole, which the next release is compared with), and answers for the dry
 * run's release of that work item alone.
 *
 * The watch goes on while the line is stopped (`worker.ts`): it only reads and records, and Stop the line's own abort
 * is one of the things it records.
 *
 * It changes nothing in Kubernetes: the line may read the Rollout, its runs and the journeys Jobs' pods, and nothing
 * else there.
 */
import { type RawEvent, RELEASE_TYPES, upcast } from '@software-factory/events';
import { lastEnd, sendSignal } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { Prometheus } from '../clients/prometheus.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { DEPLOYS } from '../github/deploys.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import {
  figuresAt,
  hashesOf,
  journeysOf,
  type RolloutRef,
  readRollout,
  routesWorse,
  seriesOf,
} from '../release/read.ts';
import { canarySignal, type FailedMeasure, failedMeasures, keyOf, type Read } from '../release/signals.ts';
import {
  dryRunEvents,
  dryRunRelease,
  type Facts,
  type Figures,
  measuresOf,
  type Needs,
  namedReleases,
  type Observed,
  observe,
  podHashes,
  type Recorded,
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
  /** Whether a release has carried it since its latest merge, and not rolled back, erred or been aborted. */
  released: boolean;
}

export class Releases {
  readonly #o: ReleasesOptions;
  /** The failed measures whose signals are in the inbox, by `keyOf`. A line started again sends them again, as the same. */
  readonly #signalled = new Set<string>();

  constructor(options: ReleasesOptions) {
    this.#o = options;
  }

  /**
   * One pass: the app's release, then a dry run's, unless told not to (the line is stopped). A failure in one leaves
   * the other to go on.
   */
  async pass({ dryRun: andDryRun = true }: { dryRun?: boolean } = {}): Promise<void> {
    const { watch, dryRun, log } = this.#o;
    if (watch) {
      await this.#watch(watch).catch((error: unknown) =>
        log.warn({ err: errorOf(error) }, 'could not read the app’s release'),
      );
    }
    if (dryRun && andDryRun) {
      await this.#dryRun().catch((error: unknown) =>
        log.warn({ err: errorOf(error) }, 'could not answer for a dry run’s release'),
      );
    }
  }

  async #watch({ kube, rollout, prometheus }: ReleaseWatchOptions): Promise<void> {
    const { log, only } = this.#o;
    const read = await readRollout(kube, rollout);
    if (!read) {
      log.debug(rollout, 'no Rollout to watch');
      return;
    }
    const o = observe(read.rollout, read.runs);
    const recorded = recordedFrom(await this.#recorded(podHashes(o), true));
    // The record holds only the releases of the hashes the Rollout names; which shipped last is asked of the store.
    const last = await this.#lastPromoted();
    const lastRelease = last?.release;
    const needs = releaseNeeds(o, recorded, lastRelease);
    const start = needs.start && (await this.#start(needs.start));
    const lastPromoted = needs.start && last?.version;
    const abortedBy = needs.aborted && o.abortedAt ? await this.#abortedBy(o.abortedAt) : undefined;
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
      const from = startOf(o, run);
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
      ...(lastRelease ? { lastRelease } : {}),
      ...(abortedBy ? { abortedBy } : {}),
      figures,
      series,
    };
    const drafts = releaseEvents(o, recorded, facts);
    // With `only`, a release that carries another work item is left unrecorded, as that work item is left as it is:
    // recorded on `only` alone, its start would never reach the other. Once the line acts on them all again, it is
    // recorded whole, or found live if it has shipped by then.
    const others = [...drafts.keys()].filter((target) => target !== null && target !== only);
    if (only !== null && others.length) {
      const release = namedReleases(o, recorded, lastRelease).current;
      log.info({ release, only, others }, 'the release carries other work items: left for the whole line');
    } else {
      await this.#append(drafts, namedReleases(o, recorded, lastRelease).current);
    }
    await this.#signal(o, recorded, series, { kube, rollout, prometheus });
  }

  /** Each failed measure of a release the line recorded, as a signal to triage, once. */
  async #signal(
    o: Observed,
    recorded: Recorded,
    drawn: ReadonlyMap<string, Series>,
    watch: ReleaseWatchOptions,
  ): Promise<void> {
    const { sql, log } = this.#o;
    const failures = failedMeasures(o, recorded);
    // Only what the cluster still has is remembered: a run gone from it is never read again.
    const live = new Set(failures.map(keyOf));
    for (const key of this.#signalled) if (!live.has(key)) this.#signalled.delete(key);
    for (const failed of failures) {
      const key = keyOf(failed);
      if (this.#signalled.has(key)) continue;
      const about = { run: failed.run.metadata.name, measure: failed.measure.name };
      try {
        const read = await this.#readFor(failed, o, drawn, watch);
        if (!read) continue;
        const { id, signal } = canarySignal(failed, read);
        await sendSignal(sql, signal, id);
        this.#signalled.add(key);
        log.info(
          { ...about, route: signal.route, symptom: signal.symptom },
          'sent triage a failed measure of the canary',
        );
      } catch (error) {
        // One measure that cannot be read or sent leaves the rest to go on, and is tried again on the next pass.
        log.warn({ ...about, err: errorOf(error) }, 'could not send a failed measure of the canary: it waits');
      }
    }
  }

  /**
   * What a failed measure's signal needs read: for errors and latency, the routes where the canary did worse, which
   * must be read (they give the signal its route), and the series, which may be left out; for the journeys, what the
   * Job wrote, once its container has ended. Undefined while there is nothing to read yet.
   */
  async #readFor(
    { run, measure }: FailedMeasure,
    o: Observed,
    drawn: ReadonlyMap<string, Series>,
    { kube, rollout, prometheus }: ReleaseWatchOptions,
  ): Promise<Read | undefined> {
    if (measure.name === 'journeys') {
      const journeys = await journeysOf(kube, rollout.namespace, run);
      if (journeys.kind === 'running') return undefined;
      return journeys.kind === 'found' ? { journeys: journeys.regressions } : {};
    }
    const hashes = hashesOf(run);
    const at = run.status.completedAt;
    const from = startOf(o, run);
    if (!hashes || !at || !from) return {};
    const routes = await routesWorse(prometheus, measure.name, hashes, new Date(from), new Date(at));
    const series =
      drawn.get(`${run.metadata.name}/${measure.name}`) ??
      (await seriesOf(prometheus, measure.name, hashes, new Date(from), new Date(at)).catch(() => undefined));
    return { ...(routes ? { routes } : {}), ...(series ? { series } : {}) };
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
    const carries = start.found
      ? await this.#foundIn(commit)
      : ((await carried(this.#o, commit, start.previous?.commit))?.map((c) => c.workItem) ?? []);
    return { commit, signed, carries };
  }

  /** Every merged work item no release has carried, not a dry run's, whose fix is already in `commit`. */
  async #foundIn(commit: string): Promise<string[]> {
    const candidates = (await this.#merged()).filter((item) => !item.released && item.number < DRY_RUN_NUMBERS_FROM);
    const found = await Promise.all(
      candidates.map(async (item) => {
        const ancestry = await commitsBetween(this.#o, item.commit, commit);
        return ancestry?.status === 'ahead' || ancestry?.status === 'identical';
      }),
    );
    return candidates.filter((_, i) => found[i]).map((item) => item.workItem);
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
        (await this.#lastPromoted())?.version ?? (await this.#o.github.read('head', this.#o.repo, { branch: 'main' }));
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
        and ${lastEnd(this.#o.sql, 'e.work_item')} is distinct from 'work-item.closed'
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
      const released = state.release !== undefined && !state.release.ended;
      return [{ workItem, ...merge, released }];
    });
  }

  /**
   * The release events recorded for these releases, upcast, in order; or, `byHash`, for every release of these
   * versions, whatever its revision.
   */
  async #recorded(names: string[], byHash = false) {
    if (!names.length) return [];
    const { sql } = this.#o;
    const release = byHash ? sql`split_part(payload->>'release', '-', 1)` : sql`payload->>'release'`;
    const rows = await sql<(RawEvent & { work_item: string | null; ts: Date })[]>`
      select seq, work_item, ts, type, version, payload from events
      where type in ${sql(RELEASE_TYPES as string[])} and ${release} in ${sql(names)}
      order by seq`;
    return rows.flatMap((row) => {
      const read = upcast({ ...row, seq: Number(row.seq) });
      if (!read.ok) return [];
      const { type, payload } = read.event;
      return [{ work_item: row.work_item, ts: new Date(row.ts).toISOString(), type, payload }];
    });
  }

  /**
   * The app's last release that shipped, by its name, and the version it made stable. A promotion of version 1, from
   * before releases were named, has no name, and says nothing of which image shipped last.
   */
  async #lastPromoted(): Promise<{ release: string | undefined; version: string } | undefined> {
    const [row] = await this.#o.sql<{ release: string | null; version: string }[]>`
      select payload->>'release' as release, payload->>'version' as version from events
      where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true
      order by seq desc limit 1`;
    return row && { release: row.release ?? undefined, version: row.version };
  }

  /** Who aborted the Rollout at `at`: Stop the line, if the line had just stopped, or Martin. */
  async #abortedBy(at: string): Promise<'stop' | 'martin'> {
    const { sql } = this.#o;
    const [last] = await sql<{ type: string; ts: Date }[]>`
      select type, ts from events
      where type in ('line.started', 'line.stopped') and ts < ${at}::timestamptz + interval '1 second'
      order by seq desc limit 1`;
    const just = last && Date.parse(at) - new Date(last.ts).getTime() <= 60_000;
    return last?.type === 'line.stopped' && just ? 'stop' : 'martin';
  }

  /** Appends every target's drafts at once: a release's events reach all of its work items, or none. */
  async #append(drafts: Map<Target, Draft[]>, release?: string): Promise<void> {
    if (!drafts.size) return;
    // A work item closed while its release ran (Martin closed it at Release) takes no more events: the store refuses
    // them, and would refuse the rest of the release's with them.
    const items = [...drafts.keys()].filter((target) => target !== null);
    const closed = items.length
      ? await this.#o.sql<{ work_item: string }[]>`
          select distinct c.work_item from events c
          where c.work_item in ${this.#o.sql(items)} and ${lastEnd(this.#o.sql, 'c.work_item')} = 'work-item.closed'`
      : [];
    for (const { work_item } of closed) drafts.delete(work_item);
    if (!drafts.size) return;
    const ts = this.#o.now().toISOString();
    const events = [...drafts].flatMap(([target, list]) => list.map((draft) => asEvent(target, draft, ts)));
    await this.#o.events.append(events);
    this.#o.log.info(
      {
        release,
        events: [...drafts].map(([target, list]) => ({ target: target ?? 'line', types: list.map((d) => d.type) })),
      },
      'recorded the app’s release',
    );
  }
}

/** A merged work item a range of the app's commits carries, as a deploy pull request names it. */
export interface Carried {
  workItem: string;
  /** Its latest pull request, which merged. */
  pullRequest: number;
  title: string | null;
  issue: number | null;
}

/**
 * The merged work items a version of the app at `head` carries over the one running now, in the order they merged:
 * each whose latest merge is in the range, and that is not closed, or was reopened since. One sent back after a merge
 * is carried only by a version with its latest fix, and one reopened only by a merge since it reopened. The deploy
 * pull request lists these, and a release starting records them.
 *
 * The range starts at the commit of the last release that shipped and was promoted, which is what the app runs: not
 * the one pinned on main, which after a rollback is the version that rolled back. Before any release is recorded, it
 * starts at `fallback`. Undefined when there is no start, or GitHub has never had one of the commits (a dry run's).
 */
export async function carried(
  o: Pick<ReleasesOptions, 'sql' | 'github' | 'repo' | 'log'>,
  head: string,
  fallback: string | undefined,
): Promise<Carried[] | undefined> {
  const { sql, log } = o;
  const [promoted] = await sql<{ commit: string | null }[]>`
    select payload->>'commit' as commit from events
    where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true
    order by seq desc limit 1`;
  const base = promoted?.commit ?? fallback;
  if (!base) return undefined;
  const range = await commitsBetween(o, base, head);
  if (!range) return undefined;
  if (!range.commits.length) return [];
  if (range.total > range.commits.length) {
    log.warn(
      { base, head, total: range.total, read: range.commits.length },
      'the version runs more commits than the line reads: it names the work items among the first',
    );
  }
  const rows = await sql<{ work_item: string; number: number; title: string | null; issue: number | null }[]>`
    select latest.work_item, latest.number, l.issue,
           (select t.public->'payload'->>'title' from events t
             where t.work_item = latest.work_item and t.type = 'ticket.opened' order by t.seq limit 1) as title
    from (
      select distinct on (m.work_item) m.work_item, m.seq, m.payload->>'commit' as commit,
             (m.payload->>'number')::int as number
      from events m
      where m.type = 'pull-request.merged' and ${lastEnd(sql, 'm.work_item')} is distinct from 'work-item.closed'
        and not exists (select 1 from events r
                        where r.work_item = m.work_item and r.type = 'work-item.reopened' and r.seq > m.seq)
      order by m.work_item, m.seq desc
    ) latest
    left join line l on l.work_item = latest.work_item
    where latest.commit in ${sql(range.commits)}
    order by latest.seq`;
  return rows.map((row) => ({ workItem: row.work_item, pullRequest: row.number, title: row.title, issue: row.issue }));
}

/** The commits from `base` to `head`, or undefined when GitHub has never had one of them. */
async function commitsBetween(o: Pick<ReleasesOptions, 'github' | 'repo'>, base: string, head: string) {
  try {
    return await o.github.read('commits', o.repo, { base, head });
  } catch (error) {
    if (error instanceof GitHubWorkerError && error.status === 404) return undefined;
    throw error;
  }
}

/** What `fold` needs to say whether a work item merged, and whether a release carries it. */
const FOLDED = [
  'pull-request.merged',
  'work.returned',
  'work-item.reopened',
  'release.started',
  'release.promoted',
  'release.rolled-back',
  'release.aborted',
  'release.errored',
];

const errorOf = (error: unknown) => ({
  type: (error as Error)?.name ?? 'Error',
  message: (error as Error)?.message ?? String(error),
});
