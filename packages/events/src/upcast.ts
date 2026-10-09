/**
 * Upcasting: reading an older event as the current version of its type. A stored event is never rewritten; each
 * read passes it through one upcaster per version until it is current.
 *
 * Plain functions with no dependencies, so the browser can upcast an event-log file as the server upcasts the store.
 */
import type { PublicEvent } from './types.ts';
import { type EventType, VERSIONS } from './versions.ts';

/** Turns a payload at one version into the next. It also receives public views, so it must not need what they leave out. */
export type Upcaster = (payload: Record<string, unknown>) => Record<string, unknown>;

export interface Catalogue {
  /** Each type's current version. */
  versions: Record<string, number>;
  /** For each type, the upcaster from version n to n + 1, keyed by n. */
  upcasters: Record<string, Record<number, Upcaster>>;
}

export const UPCASTERS: Partial<Record<EventType, Record<number, Upcaster>>> = {
  // Version 1 recorded each call, with its cassette; version 2 records an agent's step, with how many calls it made.
  'model.called': { 1: ({ cassette: _, ...payload }) => ({ ...payload, calls: 1 }) },
  // Version 2 adds the provider's own caps beside the day's and the month's, which read as they did.
  'spend.capped': { 1: (payload) => payload },
  'spend.cleared': { 1: (payload) => payload },
  // Version 2 adds the hold's cause. A version 1 hold reads as the cause its kind and stage imply, where they imply one.
  'hold.started': {
    1: (payload) => ({
      ...payload,
      cause:
        payload.kind === 'question'
          ? 'question'
          : payload.kind === 'approval'
            ? (({ triage: 'suggestion', plan: 'spec' } as Record<string, string>)[String(payload.stage)] ?? 'merge')
            : (({ gates: 'gates', review: 'review' } as Record<string, string>)[String(payload.stage)] ?? 'unknown'),
    }),
    // Version 3 adds the coder finding nothing to fix to the causes; a version 2 hold reads as it was.
    2: (payload) => payload,
    // Version 4 adds a defect the planner noticed, with its fingerprint, and a fix beyond its ticket, to the causes; a
    // version 3 hold reads as it was.
    3: (payload) => payload,
  },
  // Version 2 adds the planner's findings to the kinds of work item; a version 1 work item reads as it was.
  'work-item.opened': { 1: (payload) => payload },
  // Version 2 adds the planner to the sources of a signal; a version 1 signal reads as it was.
  'signal.received': { 1: (payload) => payload },
  // Version 2 adds where each criterion comes from. A version 1 spec never said, so its criteria read without it.
  'spec.written': { 1: (payload) => payload },
  // Version 2 adds the pull request's whole change. A version 1 push recorded only its own files, which are the whole
  // change for a first push, and the nearest the event has for a later one.
  'pull-request.pushed': { 1: (payload) => ({ ...payload, whole: payload.files }) },
  // Version 2 adds the round the return starts and what sent it back as figures; a version 1 return reads as it was.
  'work.returned': { 1: (payload) => payload },
  // Version 2 adds the line's scope fence to the mechanisms; a version 1 refusal reads as it was.
  'action.refused': { 1: (payload) => payload },
  // Version 1 counted a review's comments; version 2 carries each finding. What a version 1 comment said was never
  // recorded, so a version 1 review reads as one with no findings.
  // Version 3 lets a finding cite the ticket; a version 2 review cited none.
  'review.submitted': { 1: ({ comments: _, ...payload }) => ({ ...payload, findings: [] }), 2: (payload) => payload },
};

export const CATALOGUE: Catalogue = { versions: VERSIONS, upcasters: UPCASTERS };

/** An event as it might arrive from a store or a file written by another version of the factory. */
export interface RawEvent {
  type: string;
  version: number;
  payload: unknown;
  /** The store's order, once it has one. */
  seq?: number;
}

export type Upcast =
  | { ok: true; event: PublicEvent }
  /** Written by a newer factory than this one: a type it doesn't know, or a version beyond the current one. */
  | { ok: false; reason: 'unknown-type' | 'newer-version'; type: string; version: number };

export function upcast(event: RawEvent, catalogue: Catalogue = CATALOGUE): Upcast {
  const { type, version } = event;
  const current = Object.hasOwn(catalogue.versions, type) ? catalogue.versions[type] : undefined;
  if (current === undefined) return { ok: false, reason: 'unknown-type', type, version };
  if (version > current) return { ok: false, reason: 'newer-version', type, version };
  let payload = event.payload as Record<string, unknown>;
  for (let from = version; from < current; from++) {
    const step = catalogue.upcasters[type]?.[from];
    if (!step) throw new Error(`No upcaster for ${type} from version ${from} to ${from + 1}`);
    payload = step(payload);
  }
  return { ok: true, event: { ...event, version: current, payload } as unknown as PublicEvent };
}
