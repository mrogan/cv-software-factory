/**
 * Releases at a time t, from every release event, on a work item or on the line: one release to a `release` id. A
 * release that carries two work items has its events on each, and is one release here. The Canary panel draws the
 * newest; the Release station takes its figure from the one in flight.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import type { ItemState } from './items.ts';

type Started = PayloadOf<'release.started'>;
export type Stepped = PayloadOf<'canary.stepped'>;
export type Failed = PayloadOf<'release.rolled-back'>['failed'][number];

/** One step of the canary: a weight it holds, how long it pauses there (null: until someone promotes it), and whether the analysis judges it. */
export type Step = NonNullable<Started['steps']>[number];

export interface Measured {
  weight: number;
  at: number;
  stepped: Stepped;
}

export type End =
  | { kind: 'promoted'; at: number; weight: 100 }
  | { kind: 'rolled-back'; at: number; weight: number; reason: string; failed: Failed[]; ticket: Carried | undefined }
  | { kind: 'stopped'; at: number; weight: number };

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
}

/** What the Canary panel shows: no release yet, the newest one in full, or, once it has ended a while, one line. */
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

/** How long a release stays in full on the panel after it ends: as long as a station reads "passed". */
const SHOWN_MS = 15 * 60_000;

const ALL: Step = { weight: 100, pauseSeconds: null, analysis: true };

interface Building extends Release {
  listed: Step[] | null;
  stoppedAt: number | undefined;
}

/**
 * Where the canary is at a time: after the last step measured, and past any step the analysis does not judge whose
 * pause has run out, since such a step records nothing.
 */
function position(r: Building, now: number): Pick<Release, 'step' | 'weight' | 'until'> {
  if (!r.listed) return { step: -1, weight: r.measured.at(-1)?.weight ?? 0, until: undefined };
  const steps = r.steps;
  let step = 0;
  let from = r.startedAt;
  // A plan may hold a weight twice (a pause, then an analysis): a step measured is the next judged one at its weight.
  // Only a step that passed moves the canary on: one that could not be judged, or that waits for someone to decide,
  // holds it there, with no end to wait for.
  let holding = false;
  for (const m of r.measured) {
    const index = steps.findIndex((s, i) => i >= step && s.analysis && s.weight === m.weight);
    if (index < 0) continue;
    holding = m.stepped.analysis.phase !== 'successful';
    [step, from] = [holding ? index : index + 1, m.at];
  }
  if (holding) return { step, weight: steps[step]?.weight ?? 100, until: undefined };
  for (let s = steps[step]; s && !s.analysis && s.pauseSeconds !== null; s = steps[step]) {
    if (from + s.pauseSeconds * 1000 > now) break;
    from += s.pauseSeconds * 1000;
    step += 1;
  }
  step = Math.min(step, steps.length - 1);
  const pause = steps[step]?.pauseSeconds;
  return { step, weight: steps[step]?.weight ?? 100, until: pause == null ? undefined : from + pause * 1000 };
}

/** Every release by t, oldest first, each as far as it had got. */
export function releases(events: readonly PublicEvent[], items: readonly ItemState[], t: number): Release[] {
  const titles = new Map(items.map((item) => [item.number, item.title]));
  const carried = (number: string): Carried => ({ number, title: titles.get(number) ?? '' });
  const byId = new Map<string, Building>();
  // A rollback is a signal: the ticket it opened names the release in its evidence.
  const tickets = new Map<string, string>();
  for (const event of events) {
    const at = Date.parse(event.ts);
    // Stop the line aborts the canary in flight: the newest release, if it has not ended. An older one that never
    // recorded an end was left behind by a newer, and the stop says nothing of it.
    if (event.type === 'line.stopped') {
      const newest = [...byId.values()].at(-1);
      if (newest && !newest.end) newest.stoppedAt ??= at;
      continue;
    }
    if (event.type === 'signal.received' && event.work_item) {
      for (const evidence of event.payload.evidence ?? []) {
        if (evidence.kind === 'canary') tickets.set(evidence.release, event.work_item);
      }
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
        stoppedAt: undefined,
      });
      continue;
    }
    if (event.type !== 'canary.stepped' && event.type !== 'release.promoted' && event.type !== 'release.rolled-back')
      continue;
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
  }
  return [...byId.values()].map((r): Release => {
    const { listed: _listed, stoppedAt: _stoppedAt, ...release } = r;
    if (!r.planned) release.steps = measuredSteps(r);
    const end = endOf(r);
    const place = position(r, end?.at ?? t);
    const ticket = tickets.get(r.id);
    if (end?.kind === 'rolled-back' && ticket) end.ticket = carried(ticket);
    return { ...release, ...place, weight: end && end.kind !== 'stopped' ? end.weight : place.weight, end };
  });
}

/** A release that recorded no steps: the steps measured stand in, then all of the traffic. */
const measuredSteps = (r: Building) =>
  [...new Set([...r.measured.map((m) => m.weight), 100])].map((weight) => ({ ...ALL, weight }));

/** How a release ended, if it has: by its own event, or stopped with the line at the step it was at. */
function endOf(r: Building): End | undefined {
  if (r.end || r.stoppedAt === undefined) return r.end;
  return { kind: 'stopped', at: r.stoppedAt, weight: position(r, r.stoppedAt).weight };
}

/** The newest release, in full while it is in flight and for a while after; then one line. */
export function canaryView(all: readonly Release[], t: number): CanaryView {
  const release = all.at(-1);
  if (!release) return { state: 'none' };
  return { state: !release.end || t - release.end.at <= SHOWN_MS ? 'shown' : 'idle', release };
}

/** The release in flight: the newest, while it has not ended. */
export const inFlight = (all: readonly Release[]) => {
  const newest = all.at(-1);
  return newest && !newest.end ? newest : undefined;
};
