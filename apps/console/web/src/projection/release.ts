/**
 * Releases at a time t, from every release event, on a work item or on the line: one release to a `release` id. A
 * release that carries two work items has its events on each, and is one release here. The Canary panel draws the
 * newest; the Release station takes its figure from the one in flight.
 */
import type { PayloadOf, PublicEvent, ReleaseControl } from '@software-factory/events';
import { STEP_UP } from '../access.ts';
import { shortVersion } from '../format.ts';
import type { ItemState } from './items.ts';

type Started = PayloadOf<'release.started'>;
export type Stepped = PayloadOf<'canary.stepped'>;
export type Failed = PayloadOf<'release.rolled-back'>['failed'][number];
export type Errored = PayloadOf<'release.errored'>['errored'][number];
type AbortedBy = PayloadOf<'release.aborted'>['by'];
/**
 * What stopped a release that neither promoted nor rolled back: Stop the line, Martin, or an analysis that could not
 * judge it.
 */
export type StoppedBy = AbortedBy | 'error';

/** One step of the canary: a weight it holds, how long it pauses there (null: until someone promotes it), and whether the analysis judges it. */
export type Step = NonNullable<Started['steps']>[number];

export interface Measured {
  weight: number;
  at: number;
  stepped: Stepped;
}

export type End =
  | { kind: 'promoted'; at: number; weight: 100 }
  | { kind: 'rolled-back'; at: number; weight: number; reason: string; failed: Failed[]; ticket: Signalled | undefined }
  | { kind: 'errored'; at: number; weight: number; reason: string; errored: Errored[] }
  | { kind: 'aborted'; at: number; weight: number; by: AbortedBy };

/**
 * The ticket a rollback's signal went to, and what it did there: opened it, reopened it after a verified fix, or
 * joined it while it was still open, as another release that failed on it.
 */
export type Signalled = Carried & { how: keyof typeof SIGNALLED };

/** What a rollback's signal did to its ticket, in words: "triage added it to #1308". */
export const SIGNALLED = { opened: 'opened', reopened: 'reopened', joined: 'added it to' };

export interface Carried {
  number: string;
  title: string;
}

export interface Release {
  id: string;
  version: string;
  previous: string;
  commit: string | undefined;
  image: Started['image'];
  dryRun: boolean;
  /** The work items it carries. None: Martin's own commits, or a dependency update with no work item. */
  items: Carried[];
  startedAt: number;
  /**
   * The Rollout's steps as the release recorded them, then all of the traffic, which the Rollout does not list. A
   * release that recorded none has the steps measured stand in.
   */
  steps: Step[];
  /** Whether the steps are the release's own, rather than the steps measured. */
  planned: boolean;
  measured: Measured[];
  /** The step the canary is at, as an index into the steps: -1 when nothing says which. */
  step: number;
  /** The canary's share of the traffic, now or when it ended: 0 when nothing says yet. */
  weight: number;
  /** When the step it is at ends, if its pause ends by itself. */
  until: number | undefined;
  end: End | undefined;
  /** How each earlier attempt of the same release ended, oldest first: a retry goes again from the first step. */
  retried: End[];
  /** Martin's pause, while it holds: when he paused the canary, and the weight it keeps. */
  paused: { at: number; weight: number } | undefined;
  /** Each of Martin's promotions of this attempt, oldest first: when, and the weight it went to. */
  promotions: { at: number; to: number }[];
}

/**
 * What the Canary panel shows: no release yet, the newest one in full, or, once it has ended a while, one line. A
 * release that was stopped stays in full while it is the newest, since it waits for Martin's retry.
 */
export type CanaryView = { state: 'none' } | { state: 'shown'; release: Release } | { state: 'idle'; release: Release };

/**
 * The analysis's measures, as the panel names them, each with its rule in `policy/release.ts`'s terms. The console's
 * image is built without policy/, so it keeps these words, and a test holds them to the policy's figures.
 */
export const MEASURES = [
  ['enough-requests', 'Requests', 'enough to judge: at least 100 to the canary'],
  ['errors', 'Errors', 'share of 5xx answers · fails more than a point above'],
  ['latency', 'Latency', 'p99 · fails a quarter and 100 ms above'],
  ['journeys', 'Journeys', 'fails when a check passes on the baseline and fails here, twice'],
] as const;

/**
 * What the analysis saw of a measure that failed a release, against its limit, in the analysis's own terms
 * (`apps/factory/src/release/analysis.ts`): the requests the split sent the canary, against the fewest it needs; the
 * canary's share of 5xx answers above the baseline's, against the most it may be; how far its p99 went past the most
 * it may be, to the millisecond but never as none, since any excess fails. A limit the analysis did not record is not
 * said. A measure with no value says it in its own words, unless those are the rollback's or Argo Rollouts' ("Metric …
 * assessed Failed due to …"): the journeys report no number, and errors and latency with none had no figures to
 * compare, which the analysis counts as infinitely worse.
 *
 * Errors and latency say each version's own figure first, where the rollback's series has both at the moment the
 * analysis failed (`versionsAt`): "p99 415 ms against 39 ms: 276 ms over its limit". Each figure is rounded on its
 * own, so the last digit of the excess can differ by one from the sum a reader makes of the two beside it.
 */
export function sawOf(failed: Failed, reason: string): string {
  const { name, value, limit, message } = failed;
  const own = ownWords(message, reason);
  if (value === null)
    return (
      own ||
      (name === 'journeys'
        ? 'a check that passed on the baseline failed here'
        : 'no figures to compare, which counts as infinitely worse')
    );
  const points = (x: number) => `${(x * 100).toFixed(2)} points`;
  const against = (words: string) => (limit === null ? '' : `, against ${words}`);
  const both = versionsAt(failed);
  if (name === 'latency') {
    // In µs first, so a float such as 1.0005 s is not read as 1000.4999… ms.
    const over = `${Math.max(1, Math.round(Math.round((value - (limit ?? 0)) * 1e6) / 1000))} ms over its limit`;
    return both ? `p99 ${Math.round(both.canary)} ms against ${Math.round(both.baseline)} ms: ${over}` : `p99 ${over}`;
  }
  if (name === 'errors') {
    if (!both) return `5xx share ${points(value)} above the baseline’s${against(`at most ${points(limit ?? 0)}`)}`;
    const allowed = limit === null ? '' : `, at most ${points(limit)} allowed`;
    return `5xx share ${both.canary.toFixed(2)}% against ${both.baseline.toFixed(2)}%: ${points(value)} above${allowed}`;
  }
  if (name === 'enough-requests') return `${value} requests to the canary${against(`at least ${limit}`)}`;
  return `${value}${against(`a limit of ${limit}`)}`;
}

/**
 * The unit each measure's series is drawn in, as the line draws it (`apps/factory/src/release/read.ts`'s `DRAWN`). A
 * test holds them together.
 */
export const SERIES_UNITS: Record<string, string> = { errors: '%', latency: 'ms' };

/**
 * Each version's own figure when the analysis failed a measure: the canary's and the baseline's values at the series'
 * `at`, in its unit (a share of 5xx answers in percent, a p99 in ms). The line draws the series from the same query
 * the analysis runs for each version, over the same window, up to the run's end. Argo Rollouts ends a run in the
 * same pass as the look that fails it, so the figures there are the ones that look compared, to within a moment of
 * the window. Undefined for a measure with no series, one in a unit not its
 * own, or where either version has no value.
 */
export function versionsAt({ name, series }: Failed): { canary: number; baseline: number } | undefined {
  if (!series || series.unit !== SERIES_UNITS[name]) return undefined;
  const canary = series.canary[series.at];
  const baseline = series.baseline[series.at];
  return typeof canary === 'number' && typeof baseline === 'number' ? { canary, baseline } : undefined;
}

/**
 * How many looks of a measure failed before the rollback, as Argo Rollouts counted them in the one run that failed it:
 * across the run, not in a row. Undefined for any end but a rollback, a measure it did not fail, a rollback that did
 * not count them (version 2), and a measure more than one run failed (a step's and the background's), whose counts
 * the rollback's own table says run by run: then the verdict says "failed" alone.
 */
export function failedLooks(end: End | undefined, name: string): number | undefined {
  if (end?.kind !== 'rolled-back') return undefined;
  const runs = end.failed.filter((f) => f.name === name);
  return runs.length === 1 ? runs[0]?.failures : undefined;
}

/** A failed measure's message, when it says more than the rollback's reason or Argo Rollouts' boilerplate. */
export const ownWords = (message: string | undefined, reason: string) =>
  message !== reason && !/ assessed \w+ due to /.test(message ?? '') ? message : undefined;

/**
 * A stop in a few words: "stopped with the line" for Stop the line's abort, "aborted by Martin" for his own, "stopped
 * by an analysis error" for an analysis that could not judge it.
 */
export const stopWords = (by: StoppedBy) =>
  by === 'stop' ? 'stopped with the line' : by === 'martin' ? 'aborted by Martin' : 'stopped by an analysis error';

/** What became of a release the app went back from: "rolled back", or what stopped it. */
export const backWords = (by: StoppedBy | undefined) => (by ? stopWords(by) : 'rolled back');

/**
 * What a fix waits for after the release that carried it was stopped, as "waiting for Martin's next deploy" is after
 * a rollback: Martin's retry or his next deploy, naming him once.
 */
export const stopWait = (by: StoppedBy) => `waiting for ${by === 'martin' ? 'his' : 'Martin’s'} retry or next deploy`;

/** What stopped a release that ended short of its promotion and rollback, if something did. */
export const stoppedBy = (end: End | undefined): StoppedBy | undefined =>
  end?.kind === 'aborted' ? end.by : end?.kind === 'errored' ? 'error' : undefined;

/**
 * How a release ended, in a few words: "promoted", "rolled back", "stopped with the line", "aborted by Martin" or
 * "stopped by an analysis error".
 */
export const endedWords = (end: End) => {
  const by = stoppedBy(end);
  return by ? stopWords(by) : end.kind === 'rolled-back' ? 'rolled back' : 'promoted';
};

/** How long a release stays in full on the panel after it ends: as long as a station reads "passed". */
const SHOWN_MS = 15 * 60_000;

const ALL: Step = { weight: 100, pauseSeconds: null, analysis: true };

interface Building extends Release {
  listed: Step[] | null;
  stoppedAt: number | undefined;
}

/**
 * Where the canary is at a time: after the last step measured or the step Martin promoted it to, whichever came last,
 * and past any step the analysis does not judge whose pause has run out, since such a step records nothing. Paused by
 * Martin, it stays where it was when he paused it, at the weight it kept, with no end to wait for.
 */
function position(r: Building, now: number): Pick<Release, 'step' | 'weight' | 'until'> {
  if (!r.listed) return { step: -1, weight: r.paused?.weight ?? r.measured.at(-1)?.weight ?? 0, until: undefined };
  const steps = r.steps;
  const paused = r.paused && r.paused.at <= now ? r.paused : undefined;
  const asOf = paused ? paused.at : now;
  let step = 0;
  let from = r.startedAt;
  // A plan may hold a weight twice (a pause, then an analysis): a step measured is the next judged one at its weight.
  // Only a step that passed moves the canary on: one that could not be judged, or that waits for someone to decide,
  // holds it there, with no end to wait for. Martin's promotion moves it to the step that sets the weight it went to.
  let holding = false;
  const moves = [
    // Paused, it moves no further, whatever is recorded after.
    ...r.measured.filter((m) => m.at <= asOf).map((m) => ({ at: m.at, m, to: undefined })),
    ...r.promotions.filter((p) => p.at <= asOf).map((p) => ({ at: p.at, m: undefined, to: p.to })),
  ].sort((a, b) => a.at - b.at);
  for (const { at, m, to } of moves) {
    if (m) {
      const index = steps.findIndex((s, i) => i >= step && s.analysis && s.weight === m.weight);
      if (index < 0) continue;
      holding = m.stepped.analysis.phase !== 'successful';
      [step, from] = [holding ? index : index + 1, m.at];
    } else {
      const index = steps.findIndex((s, i) => i >= step && s.weight === to);
      if (index < 0) continue;
      [step, from, holding] = [index, at, false];
    }
  }
  if (holding) return { step, weight: paused?.weight ?? steps[step]?.weight ?? 100, until: undefined };
  for (let s = steps[step]; s && !s.analysis && s.pauseSeconds !== null; s = steps[step]) {
    if (from + s.pauseSeconds * 1000 > asOf) break;
    from += s.pauseSeconds * 1000;
    step += 1;
  }
  step = Math.min(step, steps.length - 1);
  const pause = steps[step]?.pauseSeconds;
  if (paused) return { step, weight: paused.weight, until: undefined };
  return { step, weight: steps[step]?.weight ?? 100, until: pause == null ? undefined : from + pause * 1000 };
}

/** Every release by t, oldest first, each as far as it had got. */
export function releases(events: readonly PublicEvent[], items: readonly ItemState[], t: number): Release[] {
  const titles = new Map(items.map((item) => [item.number, item.title]));
  const carried = (number: string): Carried => ({ number, title: titles.get(number) ?? '' });
  const byId = new Map<string, Building>();
  // A rollback is a signal: the ticket it went to names the release in its evidence. Whether it opened, reopened or
  // joined that ticket is told by the work item's events before it.
  const tickets = new Map<string, { number: string; how: Signalled['how'] }>();
  const signalled = new Set<string>();
  const reopened = new Set<string>();
  // Whether the history records aborts: one that does has no stop to infer.
  let recordsAborts = false;
  for (const event of events) {
    const at = Date.parse(event.ts);
    // Stop the line aborts the canary in flight, and the line records the abort. A history from before it did has
    // only the stop: the newest release, if it has not ended, is read as aborted by it, until it records an end of its
    // own. An older one that never recorded an end was left behind by a newer, and the stop says nothing of it. Once
    // the history has recorded an abort, a stop is never read as one.
    if (event.type === 'line.stopped') {
      if (recordsAborts) continue;
      const newest = [...byId.values()].at(-1);
      if (newest && !newest.end) newest.stoppedAt ??= at;
      continue;
    }
    if (event.type === 'work-item.reopened' && event.work_item) {
      reopened.add(event.work_item);
      continue;
    }
    if (event.type === 'signal.received' && event.work_item) {
      const number = event.work_item;
      const how = !signalled.has(number) ? 'opened' : reopened.has(number) ? 'reopened' : 'joined';
      for (const evidence of event.payload.evidence ?? []) {
        if (evidence.kind === 'canary') tickets.set(evidence.release, { number, how });
      }
      signalled.add(number);
      reopened.delete(number);
      continue;
    }
    if (event.type === 'release.started') {
      const p = event.payload;
      const known = byId.get(p.release);
      // The same start on another work item it carries. One after the release ended is a retry: it goes again, from
      // its first step, as the newest release, carrying what it carried.
      if (known && !known.end && known.stoppedAt === undefined) {
        if (event.work_item && !known.items.some((i) => i.number === event.work_item))
          known.items.push(carried(event.work_item));
        continue;
      }
      const items = known?.items ?? [];
      const ended = known && endOf(known);
      const retried = known ? [...known.retried, ...(ended ? [ended] : [])] : [];
      if (event.work_item && !items.some((i) => i.number === event.work_item)) items.push(carried(event.work_item));
      byId.delete(p.release);
      const listed = p.steps?.length ? p.steps : null;
      byId.set(p.release, {
        id: p.release,
        version: p.version,
        previous: p.previous,
        commit: p.commit,
        image: p.image,
        dryRun: p.dryRun,
        items,
        startedAt: at,
        listed,
        steps: listed ? (listed.at(-1)?.weight === 100 ? listed : [...listed, ALL]) : [],
        planned: Boolean(listed),
        measured: [],
        step: 0,
        weight: 0,
        until: undefined,
        end: undefined,
        retried,
        paused: undefined,
        promotions: [],
        stoppedAt: undefined,
      });
      continue;
    }
    // Martin's controls from the console: a pause holds the canary where it is until he resumes, promotes or aborts it;
    // a promotion moves it on. What the Rollout then does, the line records.
    if (event.type === 'release.controlled') {
      const r = byId.get(event.payload.release);
      if (!r || r.end) continue;
      const { action, weight, to } = event.payload;
      if (action === 'pause') r.paused = { at, weight };
      else if (action !== 'retry') r.paused = undefined;
      if (to !== undefined) r.promotions.push({ at, to });
      continue;
    }
    if (
      event.type !== 'canary.stepped' &&
      event.type !== 'release.promoted' &&
      event.type !== 'release.rolled-back' &&
      event.type !== 'release.errored' &&
      event.type !== 'release.aborted'
    )
      continue;
    // A line that records an analysis's Error records aborts too.
    if (event.type === 'release.aborted' || event.type === 'release.errored') recordsAborts = true;
    const r = byId.get(event.payload.release);
    if (!r || r.end) continue;
    if (event.type === 'canary.stepped') {
      const { weight } = event.payload;
      // The line records a step on each work item the release carries, not always in the same pass.
      if (!r.measured.some((m) => m.weight === weight)) r.measured.push({ weight, at, stepped: event.payload });
    }
    if (event.type === 'release.promoted') r.end = { kind: 'promoted', at, weight: 100 };
    if (event.type === 'release.rolled-back') {
      const { weight, reason, failed } = event.payload;
      r.end = { kind: 'rolled-back', at, weight, reason, failed, ticket: undefined };
    }
    // Recorded a pass after Argo Rollouts acted on the abort the Error made: it ended then.
    if (event.type === 'release.errored') {
      const { weight, reason, errored, abortedAt } = event.payload;
      r.end = { kind: 'errored', at: Date.parse(abortedAt), weight, reason, errored };
    }
    // Recorded a pass after Argo Rollouts acted on it: it ended then, at the step it had reached.
    if (event.type === 'release.aborted') r.end = abortedAt(r, Date.parse(event.payload.abortedAt), event.payload.by);
  }
  return [...byId.values()].map((r): Release => {
    const { listed: _listed, stoppedAt: _stoppedAt, ...release } = r;
    if (!r.planned) release.steps = measuredSteps(r);
    const end = endOf(r);
    const place = position(r, end?.at ?? t);
    const ticket = tickets.get(r.id);
    if (end?.kind === 'rolled-back' && ticket) end.ticket = { ...carried(ticket.number), how: ticket.how };
    return { ...release, ...place, weight: end ? end.weight : place.weight, end };
  });
}

/** A release that recorded no steps: the steps measured stand in, then all of the traffic. */
const measuredSteps = (r: Building) =>
  [...new Set([...r.measured.map((m) => m.weight), 100])].map((weight) => ({ ...ALL, weight }));

/** How a release ended, if it has: by its own event, or, in a history from before aborts were recorded, the line's stop. */
function endOf(r: Building): End | undefined {
  if (r.end || r.stoppedAt === undefined) return r.end;
  return abortedAt(r, r.stoppedAt, 'stop');
}

/** An abort at a time, at the step the canary had reached: the Rollout no longer says which. */
const abortedAt = (r: Building, at: number, by: AbortedBy): End => ({
  kind: 'aborted',
  at,
  weight: position(r, at).weight,
  by,
});

/** The newest release, in full while it is in flight and for a while after; then one line. */
export function canaryView(all: readonly Release[], t: number): CanaryView {
  const release = all.at(-1);
  if (!release) return { state: 'none' };
  const waits = !release.dryRun && (release.end?.kind === 'aborted' || release.end?.kind === 'errored');
  return { state: !release.end || waits || t - release.end.at <= SHOWN_MS ? 'shown' : 'idle', release };
}

/**
 * One of Martin's controls of the canary, as the panel offers it: the action, its label, what it does, whether it asks
 * for the passkey again (`policy/access.ts`'s `release.promote` and `release.retry`; the console's image is built
 * without policy/, so it keeps this copy, and a test holds the two together), and why it cannot be pressed now, if it
 * cannot.
 */
export interface Control {
  action: ReleaseControl;
  label: string;
  what: string;
  stepUp: boolean;
  /** For a promotion, the weight it goes to. */
  to?: number;
  off?: string;
}

/**
 * Martin's controls of a release, as it stands: in flight, promote it to the next step's weight (when there is a step
 * before all of the traffic) or fully, pause or resume it, and abort it; stopped (by him, with the line, or by an
 * analysis error), retry it, but not while the line is stopped, which starts no canary. Promoted, rolled back or a dry
 * run's: none. There is never a rollback: that is the analysis's alone.
 */
export function controlsOf(r: Release, lineStopped: boolean): Control[] {
  if (r.dryRun) return [];
  const version = shortVersion(r.version);
  const control = (action: ReleaseControl, label: string, what: string, off?: string): Control => ({
    action,
    label,
    what,
    stepUp: STEP_UP[action],
    ...(off && { off }),
  });
  if (r.end) {
    if (r.end.kind !== 'aborted' && r.end.kind !== 'errored') return [];
    const off = lineStopped ? 'Start the line first: a stopped line starts no canary.' : undefined;
    return [control('retry', 'Retry', `Starts ${version}’s canary again from its first step.`, off)];
  }
  const next = r.steps.slice(r.step + 1).find((s) => s.weight > r.weight && s.weight < 100)?.weight;
  return [
    ...(next === undefined
      ? []
      : [
          {
            ...control(
              'promote',
              `Promote to ${next}%`,
              'Moves the canary to its next step now, without waiting out this one.',
            ),
            to: next,
          },
        ]),
    control(
      'promote-fully',
      'Promote fully',
      `Gives ${version} all the traffic now${next ? ', skipping the steps left' : ''}.`,
    ),
    r.paused
      ? control('resume', 'Resume', 'Gives the canary back to its analysis, to move on by itself again.')
      : control('pause', 'Pause', `Holds the canary at ${r.weight}% until Martin resumes it.`),
    control(
      'abort',
      'Abort',
      `Sends all the traffic back to ${shortVersion(r.previous)}. Nothing failed, so it opens no ticket.`,
    ),
  ];
}

/** The release in flight: the newest, while it has not ended. */
export const inFlight = (all: readonly Release[]) => {
  const newest = all.at(-1);
  return newest && !newest.end ? newest : undefined;
};
