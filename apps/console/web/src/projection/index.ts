/**
 * The console as a pure function of events and a time t (ADR 0002). Live is t = now; replay is any other t; the
 * code is the same, because the projection cannot tell where its events came from.
 *
 * Plain TypeScript with no React in it, so Node tests it directly.
 */
import type { PublicEvent, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import { foldItems, type ItemState } from './items.ts';
import {
  drawn,
  type Header,
  header,
  panel,
  type Return,
  returnsAt,
  type Score,
  type StagePanel,
  type Station,
  score,
  station,
} from './line.ts';
import { type Card, card, type Timeline, timeline } from './reel.ts';
import { type CanaryView, canaryView, releases } from './release.ts';
import { type Sheet, sheet } from './sheet.ts';

export type { Attempt, Finding, ThreadReview } from './fixing.ts';
export type { Capture, ItemState, Outcome } from './items.ts';
export type {
  CapSpell,
  Header,
  PanelRow,
  ProviderSpell,
  Return,
  Score,
  SenseCount,
  StagePanel,
  Station,
  Status,
} from './line.ts';
export { whileSending } from './line.ts';
export type { Card, Picture, Segment, Source, Tag, Timeline, Versions } from './reel.ts';
export { QUARANTINE_AT, segmentsLabel } from './reel.ts';
export type { CanaryView, Carried, End, Measured, Release, Step } from './release.ts';
export type {
  After,
  AgentRow,
  Chapter,
  GateRow,
  PageComparison,
  ScopeRow,
  SenseEvidence,
  Sheet,
  Sighting,
} from './sheet.ts';

export interface View {
  t: number;
  /** The store holds samples, and the console says so. */
  sample: boolean;
  header: Header;
  /** The scoreboard, beside the app's name; nothing when it has never published. */
  score: Score | undefined;
  stations: Station[];
  /** Work sent back upstream that has not moved on since, newest first, to be drawn one at a time. */
  returns: Return[];
  panels: Record<Stage, StagePanel>;
  /** The Canary panel: the newest release, on a work item or on the line. */
  canary: CanaryView;
  cards: Card[];
  timeline: Timeline;
}

/** The events that had happened by t, in seq order. */
export const upTo = (events: readonly PublicEvent[], t: number) => events.filter((event) => Date.parse(event.ts) <= t);

export function project(events: readonly PublicEvent[], t: number): View {
  const seen = upTo(events, t);
  const items = foldItems(seen);
  const line = header(seen);
  const sent = returnsAt(seen, t);
  const returns = drawn(sent, items);
  const cards = items.map((item) => card(item, seen, t));
  const shipped = releases(seen, items, t);
  return {
    t,
    sample: items.some((item) => item.sample),
    header: line,
    score: score(seen),
    stations: STAGES.map((stage) => station(stage, items, sent, line, t, shipped)),
    returns,
    panels: Object.fromEntries(
      STAGES.map((stage) => [stage, panel(stage, items, sent, seen, line, t, shipped)]),
    ) as Record<Stage, StagePanel>,
    canary: canaryView(shipped, t),
    cards,
    timeline: timeline(cards),
  };
}

/** One work item's sheet at t, or nothing if it had not opened by then. */
export function projectSheet(events: readonly PublicEvent[], item: string, t: number): Sheet | undefined {
  const seen = upTo(events, t);
  const state: ItemState | undefined = foldItems(seen.filter((event) => event.work_item === item))[0];
  return state && sheet(state, seen, t);
}
