/**
 * The console as a pure function of events and a time t (ADR 0002). Live is t = now; replay is any other t; the
 * code is the same, because the projection cannot tell where its events came from.
 *
 * Plain TypeScript with no React in it, so Node tests it directly.
 */
import type { PublicEvent, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import { foldItems, type ItemState } from './items.ts';
import { type Header, header, panel, type Return, returnsAt, type StagePanel, type Station, station } from './line.ts';
import { type Card, card, type Timeline, timeline } from './reel.ts';
import { type Sheet, sheet } from './sheet.ts';

export type { Capture, ItemState, Outcome } from './items.ts';
export type { CapSpell, Header, PanelRow, Return, SenseCount, StagePanel, Station, Status } from './line.ts';
export { whileSending } from './line.ts';
export type { Card, Picture, Segment, Source, Tag, Timeline, Versions } from './reel.ts';
export { QUARANTINE_AT, segmentsLabel } from './reel.ts';
export type { AgentRow, Chapter, GateRow, PageComparison, SenseEvidence, Sheet, Sighting } from './sheet.ts';

export interface View {
  t: number;
  /** The store holds samples, and the console says so. */
  sample: boolean;
  header: Header;
  stations: Station[];
  /** Work sent back upstream, newest first, to be drawn one at a time. */
  returns: Return[];
  panels: Record<Stage, StagePanel>;
  cards: Card[];
  timeline: Timeline;
}

/** The events that had happened by t, in seq order. */
export const upTo = (events: readonly PublicEvent[], t: number) => events.filter((event) => Date.parse(event.ts) <= t);

export function project(events: readonly PublicEvent[], t: number): View {
  const seen = upTo(events, t);
  const items = foldItems(seen);
  const line = header(seen);
  const returns = returnsAt(seen, t);
  const cards = items.map((item) => card(item, seen, t));
  return {
    t,
    sample: items.some((item) => item.sample),
    header: line,
    stations: STAGES.map((stage) => station(stage, items, returns, line, t)),
    returns,
    panels: Object.fromEntries(STAGES.map((stage) => [stage, panel(stage, items, seen, line, t)])) as Record<
      Stage,
      StagePanel
    >,
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
