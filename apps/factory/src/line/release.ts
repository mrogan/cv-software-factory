/**
 * The line's watch of the app's releases (`release/watch.ts` decides; this reads and appends). Each pass reads the
 * Rollout and its AnalysisRuns, the release events already recorded for the versions they name, and, only when there is
 * something new to record, what it needs for it:
 *
 * - for a release starting, the new image's commit and signature, through the GitHub worker (the line has no way to
 *   GHCR), and the work items it carries (`carried`): those whose fixes merged between the commit the last promoted
 *   release runs and the new image's, as the deploy pull request lists them. For a version found live, each merged
 *   work item no release has carried whose fix is already in it. A commit GitHub never had (a dry run's) is in neither.
 * - for each step, each version's figures from Prometheus, and how many of the journeys' checks passed of how many ran,
 *   from the Job's termination message; for a rollback, the series of each failed measure.
 * - for an abort, who made it, from the control the admin service records once its patch is made
 *   (`release.controlled`, appended by one of Martin's roles), within the minute before the abort: Stop the line, when
 *   the control says it came with the console's stop; Martin, when he aborted this release from the Canary panel.
 *   With no control, Stop the line when the line's last word before the abort is that it stopped, within the minute
 *   before: `make stop-the-line` records the line's stop and then aborts every release in flight with a script that
 *   records nothing, and the console's stop records no control for a release the line had not recorded yet. Otherwise
 *   Martin, by hand with his own credentials, the one other way a Rollout is aborted. The admin service records a
 *   control just after its patch, so an abort less than fifteen seconds old that no control has claimed waits a pass.
 *   Argo Rollouts keeps the abort's time to the second, cut short, so a control or a stop recorded within the second
 *   after it counts as before it.
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

import { type Attributes, trace } from '@opentelemetry/api';
import { type RawEvent, upcast } from '@software-factory/events';
import { fromMartin, lastEnd, sendSignal } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { Prometheus } from '../clients/prometheus.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { DEPLOYS } from '../github/deploys.ts';
import { GitHubWorkerError } from '../github/worker-client.ts';
import {
  figuresAt,
  hashesOf,
  journeysCounted,
  journeysOf,
  readRollout,
  routesWorse,
  seriesOf,
} from '../release/read.ts';
import { lastPromoted, type Recorded, recordedFrom, releaseRecords, type Target } from '../release/recorded.ts';
import { namedReleases, type Observed, observe, podHashes } from '../release/rollout.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import { canarySignal, type FailedMeasure, failedMeasures, keyOf, type Read } from '../release/signals.ts';
import {
  dryRunEvents,
  dryRunRelease,
  type Facts,
  type Figures,
  measuresOf,
  type Needs,
  releaseEvents,
  releaseNeeds,
  type Series,
  type Start,
  startOf,
} from '../release/watch.ts';
import type { Kube } from '../runners/kube.ts';
import { ATTRIBUTES as A, inSpan } from '../spans.ts';
import { asEvent, type Draft } from './gates.ts';
import { fold, type LineEvent } from './machine.ts';
import { type Counted, countReleaseEnd, type Ending, endingsIn } from './metrics.ts';
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
  /** The one work item the line acts on, or null for them all: its own default, until the line sets it (`act`). */
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
    this.#o = { ...options };
  }

  /** The one work item the line acts on from now, or null for them all: the line sets it each pass, from its take. */
  actOn(only: string | null): void {
    this.#o.only = only;
  }

  /**
   * One pass: the app's release, then a dry run's, unless told not to (the line is stopped). A failure in one leaves
   * the other to go on.
   */
  async pass({ dryRun: andDryRun = true }: { dryRun?: boolean } = {}): Promise<void> {
    const { watch, dryRun, log } = this.#o;
    if (watch) {
      await this.#watch(watch).catch((error: unknown) => log.warn({ err: error }, 'could not read the app’s release'));
    }
    if (dryRun && andDryRun) {
      await this.#dryRun().catch((error: unknown) =>
        log.warn({ err: error }, 'could not answer for a dry run’s release'),
      );
    }
  }

  async #watch(watch: ReleaseWatchOptions): Promise<void> {
    const { log } = this.#o;
    const { kube, rollout } = watch;
    const read = await readRollout(kube, rollout);
    if (!read) {
      log.debug(rollout, 'no Rollout to watch');
      return;
    }
    const o = observe(read.rollout, read.runs);
    const recorded = recordedFrom(await releaseRecords(this.#o.sql, podHashes(o), true));
    // The record holds only the releases of the hashes the Rollout names; which shipped last is asked of the store.
    const last = await lastPromoted(this.#o.sql);
    const lastRelease = last?.release;
    const needs = releaseNeeds(o, recorded, lastRelease);
    // A pass with something to read for a release, or a failed measure to send triage, is the release's span; one with
    // only something to record has a span for the recording (`#append`), and an idle pass none.
    const unsent = failedMeasures(o, recorded).some((failed) => !this.#signalled.has(keyOf(failed)));
    const reads =
      Boolean(needs.start) || needs.steps.length > 0 || needs.failures.length > 0 || needs.aborted || unsent;
    if (!reads) return this.#record(o, recorded, last, needs, watch, false);
    const release = namedReleases(o, recorded, lastRelease).current;
    await inSpan('release', releaseAttributes(release), () => this.#record(o, recorded, last, needs, watch, true));
  }

  /** Reads what a pass needs, and records what it found: inside the release's span when `traced`. */
  async #record(
    o: Observed,
    recorded: Recorded,
    last: { release: string | undefined; version: string } | undefined,
    needs: Needs,
    { kube, rollout, prometheus }: ReleaseWatchOptions,
    traced: boolean,
  ): Promise<void> {
    const { log, only } = this.#o;
    const lastRelease = last?.release;
    const start = needs.start && (await this.#start(needs.start));
    const lastPromoted = needs.start && last?.version;
    const aborting = needs.aborted ? namedReleases(o, recorded, lastRelease).current : undefined;
    const abortedBy = aborting && o.abortedAt ? await this.#abortedBy(o.abortedAt, aborting) : undefined;
    const figures = new Map<string, Figures>();
    for (const run of needs.steps) {
      const hashes = hashesOf(run);
      const at = run.status.completedAt;
      if (!hashes || !at) continue;
      // The counts are Kubernetes's, not Prometheus's: one that cannot be read leaves the other its figures.
      const [read, journeys] = await Promise.all([
        figuresAt(prometheus, hashes, new Date(at)).catch((error: unknown) => {
          log.warn({ run: run.metadata.name, err: error }, 'could not read a step’s figures');
          return undefined;
        }),
        journeysCounted(kube, rollout.namespace, run).catch((error: unknown) => {
          log.warn({ run: run.metadata.name, err: error }, 'could not read the journeys’ counts at a step');
          return undefined;
        }),
      ]);
      if (read || journeys) {
        const none = { requests: null, errorRate: null, p99Ms: null };
        figures.set(run.metadata.name, {
          canary: { ...(read?.canary ?? none), journeys: journeys?.canary ?? null },
          baseline: { ...(read?.baseline ?? none), journeys: journeys?.baseline ?? null },
        });
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
          log.warn({ run: run.metadata.name, measure: measure.name, err: error }, 'could not draw a series');
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
      const release = namedReleases(o, recorded, lastRelease).current;
      await this.#append(drafts, release, traced ? undefined : releaseAttributes(release));
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
        log.warn({ ...about, err: error }, 'could not send a failed measure of the canary: it waits');
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
    const image = DEPLOYS.find((t) => t.repo === repo)?.pins.find((p) => !p.what)?.images[0]?.image;
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
    const recorded = recordedFrom(
      await releaseRecords(
        this.#o.sql,
        merged.map((item) => dryRunRelease(item.commit)),
      ),
    );
    let previous: string | undefined;
    const drafts = new Map<Target, Draft[]>();
    for (const item of merged) {
      const record = recorded.get(dryRunRelease(item.commit))?.get(item.workItem);
      if (record?.ended === 'promoted' || (item.released && !record)) continue;
      // The version it would have replaced: the last that shipped, or before any, main as it is.
      previous ??=
        (await lastPromoted(this.#o.sql))?.version ??
        (await this.#o.github.read('head', this.#o.repo, { branch: 'main' }));
      const due = dryRunEvents(item, previous, record, now(), dryRunEveryMs);
      if (due.length) drafts.set(item.workItem, due);
    }
    await this.#append(drafts, undefined, releaseAttributes(undefined, true));
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
   * Who aborted a release at `at`: Stop the line, if the console's stop aborted it, as its control says; Martin, if his
   * control from the Canary panel did; Stop the line, if the line had just stopped, which is how `make stop-the-line`'s
   * abort is told, as its script holds no role in the store and records nothing; or else Martin, by hand.
   */
  async #abortedBy(at: string, release: string): Promise<'stop' | 'martin' | undefined> {
    const { sql, now } = this.#o;
    const [control] = await sql<{ stop: boolean }[]>`
      select coalesce((e.payload->>'stop')::boolean, false) as stop from events e
      where e.type = 'release.controlled' and e.payload->>'action' = 'abort' and e.payload->>'release' = ${release}
        and e.ts < ${at}::timestamptz + interval '1 second' and e.ts >= ${at}::timestamptz - interval '1 minute'
        and ${fromMartin(sql, 'e')}
        -- This attempt's: after the abort or Error that ended the one before it, if it was retried.
        and e.ts >= coalesce((
          select max((p.payload->>'abortedAt')::timestamptz) from events p
          where p.type in ('release.aborted', 'release.errored') and p.payload->>'release' = ${release}
            and (p.payload->>'abortedAt')::timestamptz < ${at}::timestamptz
        ) + interval '1 second', '-infinity')
      order by e.seq desc limit 1`;
    if (control) return control.stop ? 'stop' : 'martin';
    // The admin service records its control just after its patch: an abort only seconds old waits a pass for it.
    if (now().getTime() - Date.parse(at) < CONTROL_LAG_MS) return undefined;
    // The command line's stop, or the console's of a release the line had not recorded yet, which no control names:
    // told by time.
    const [last] = await sql<{ type: string; ts: Date }[]>`
      select e.type, e.ts from events e
      where e.type in ('line.started', 'line.stopped') and e.ts < ${at}::timestamptz + interval '1 second'
        and ${fromMartin(sql, 'e')}
      order by e.seq desc limit 1`;
    const just = last && Date.parse(at) - new Date(last.ts).getTime() <= 60_000;
    return last?.type === 'line.stopped' && just ? 'stop' : 'martin';
  }

  /**
   * Appends every target's drafts at once: a release's events reach all of its work items, or none. With `span`, in a
   * release span of its own, when anything is left to append.
   */
  async #append(drafts: Map<Target, Draft[]>, release?: string, span?: Attributes): Promise<void> {
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
    if (span) return inSpan('release', span, () => this.#write(drafts, items, release));
    return this.#write(drafts, items, release);
  }

  /**
   * The releases' ends among events about to be appended that the store has not recorded yet, on any work item or the
   * line: a release carried by a work item recorded on a later pass than the rest ended once, and is counted once.
   */
  async #newEndings(events: readonly Counted[]): Promise<Ending[]> {
    const endings = endingsIn(events);
    if (!endings.length) return [];
    const sql = this.#o.sql;
    // Only the count depends on it: a read that fails counts each end as new, and records the release all the same.
    const recorded = await sql<{ type: string; release: string }[]>`
      select distinct type, payload->>'release' as release from events
      where type in ${sql(endings.map((e) => e.type))} and payload->>'release' in ${sql(endings.map((e) => e.release))}`.catch(
      (error: unknown) => {
        this.#o.log.warn({ err: error }, 'could not read which release ends are recorded: counting them all');
        return [];
      },
    );
    const seen = new Set(recorded.map((row) => `${row.type} ${row.release}`));
    return endings.filter((e) => !seen.has(`${e.type} ${e.release}`));
  }

  async #write(drafts: Map<Target, Draft[]>, items: string[], release?: string): Promise<void> {
    trace.getActiveSpan()?.setAttribute(
      A.workItems,
      items.filter((item) => drafts.has(item)),
    );
    const ts = this.#o.now().toISOString();
    const events = [...drafts].flatMap(([target, list]) => list.map((draft) => asEvent(target, draft, ts)));
    const endings = await this.#newEndings(events);
    await this.#o.events.append(events);
    for (const ending of endings) countReleaseEnd(ending);
    this.#o.log.info(
      {
        release,
        events: [...drafts].map(([target, list]) => ({ target: target ?? 'line', types: list.map((d) => d.type) })),
      },
      'recorded the app’s release',
    );
  }
}

/** How long after an abort the line waits for the console's control that made it to be recorded. */
const CONTROL_LAG_MS = 15_000;

/** A release span's attributes: which release, when the Rollout names one, and whether it is a dry run's. */
const releaseAttributes = (release: string | undefined, dryRun = false) => ({
  ...(release ? { [A.release]: release } : {}),
  [A.dryRun]: dryRun,
});

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
