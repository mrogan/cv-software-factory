/**
 * The line at time t: whether it runs, each station's state and figure, the returns waiting to be drawn, and what
 * each stage panel lists.
 */
import type { Autonomy, PayloadOf, PublicEvent, Sense, Stage } from '@software-factory/events';
import { SENSES, STAGES } from '@software-factory/events';
import type { ItemState } from './items.ts';

export type Status = 'idle' | 'working' | 'returning' | 'passing' | 'blocked' | 'failed';

/** How long a return keeps its sender "sending back". */
export const RETURNING_MS = 5 * 60_000;
/** How long a stage reads "passed" after an item leaves it, with nothing else in it. */
export const PASSING_MS = 15 * 60_000;
/** How far back returns are kept, to be drawn one at a time. */
export const RETURNS_MS = 24 * 3_600_000;

type Cap = PayloadOf<'spend.capped'>['cap'];

/** A spend cap reached, and when it cleared, if it has. */
export interface CapSpell {
  cap: Cap;
  limitUsd: number;
  spentUsd: number;
  /** When the cap was due to reset, as the gateway said when it was reached. */
  resets: number;
  reached: number;
  cleared: number | undefined;
}

export interface Header {
  running: boolean;
  autonomy: Autonomy | undefined;
  /** Why the line was stopped, when it is. */
  stopped: string | undefined;
  /** A spend cap reached and not yet cleared: the gateway refuses every model call until it resets. */
  capped: CapSpell | undefined;
  /** Every cap reached so far, oldest first. */
  caps: CapSpell[];
}

export interface Station {
  stage: Stage;
  status: Status;
  /** One short figure for the caption, such as "2 PRs" or "25%". */
  figure: string;
  /** Tickets queued in the stage, waiting for it to take them: drawn as parcels on the belt in front of it. */
  queued: number;
  /** At Triage, while a spend cap holds: when it resets. The station says "capped", and until when. */
  cappedUntil: number | undefined;
}

export interface Return {
  item: string;
  from: Stage;
  to: Stage;
  text: string;
  at: number;
}

export interface PanelRow {
  item: string;
  title: string;
  note: string;
  tone: 'signal' | 'ok' | 'attn' | 'faint';
  at: number;
}

/** What one sense has sent Triage, counted from events: the signals it became, and the tickets they opened. */
export interface SenseCount {
  sense: Sense;
  signals: number;
  tickets: number;
  /** For reports: where triage sent each one that did not open a ticket. */
  routes: { quarantined: number; parked: number; closed: number; joined: number } | undefined;
}

export interface StagePanel {
  stage: Stage;
  rows: PanelRow[];
  /** Triage: where its work comes from. */
  senses: SenseCount[] | undefined;
  /** Triage: a spend cap that holds, or that cleared today, so one that has cleared can still be seen. */
  caps: CapSpell[];
  /** Tickets waiting in the stage for it to take them. */
  queued: number;
}

export function header(events: readonly PublicEvent[]): Header {
  let state: Header = { running: false, autonomy: undefined, stopped: undefined, capped: undefined, caps: [] };
  for (const event of events) {
    if (event.type === 'line.started') {
      state = { ...state, running: true, autonomy: event.payload.autonomy, stopped: undefined };
    }
    if (event.type === 'line.stopped') state = { ...state, running: false, stopped: event.payload.reason };
    if (event.type === 'spend.capped') {
      const { cap, limitUsd, spentUsd, resets } = event.payload;
      const spell = { cap, limitUsd, spentUsd, resets: Date.parse(resets), reached: Date.parse(event.ts) };
      state = { ...state, caps: [...state.caps, { ...spell, cleared: undefined }] };
    }
    if (event.type === 'spend.cleared') {
      const at = Date.parse(event.ts);
      const caps = state.caps.map((spell) =>
        spell.cap === event.payload.cap && spell.cleared === undefined ? { ...spell, cleared: at } : spell,
      );
      state = { ...state, caps };
    }
  }
  // When the day's and the month's caps both hold, the month's says when work resumes: it resets last.
  const holding = state.caps.filter((spell) => spell.cleared === undefined);
  return { ...state, capped: holding.find((spell) => spell.cap === 'month') ?? holding[0] };
}

/** Items in a stage now: open, and that stage their latest. */
const inStage = (items: readonly ItemState[], stage: Stage) =>
  items.filter((item) => item.closedAt === undefined && item.stage === stage);

/** How an item closed by a stage's own work, with no failure, ended: it passed through the stage, and is done. */
const CLOSED_NOTE: Partial<Record<ItemState['outcome'], string>> = {
  verified: 'verified',
  closed: 'closed, no change',
  quarantined: 'quarantined',
  'no-ticket': 'closed, no ticket',
};

/** Items that left a stage for a later one, or closed in it successfully, and when. */
function leavers(items: readonly ItemState[], stage: Stage): { item: ItemState; at: number }[] {
  return items.flatMap((item) => {
    const left = item.visits[stage]?.leftAt;
    if (left === undefined) return [];
    const closedHere = item.closedAt !== undefined && item.stage === stage;
    if (closedHere && (!CLOSED_NOTE[item.outcome] || item.failure)) return [];
    if (!closedHere && item.stage && STAGES.indexOf(item.stage) < STAGES.indexOf(stage)) return [];
    return [{ item, at: left }];
  });
}

const NOUNS: Record<Stage, [one: string, many: string]> = {
  sense: ['signal', 'signals'],
  triage: ['signal', 'signals'],
  plan: ['spec', 'specs'],
  build: ['change', 'changes'],
  gates: ['PR', 'PRs'],
  review: ['PR', 'PRs'],
  release: ['release', 'releases'],
  verify: ['check', 'checks'],
};

const count = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

/** The start of the day t falls in, where the viewer is. */
export function startOfDay(t: number): number {
  const day = new Date(t);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * A station's state at t, by the first rule that matches (the design system's README, "From events to a station's
 * status"). Under Stop the line, every station needs you.
 */
export function station(
  stage: Stage,
  items: readonly ItemState[],
  returns: readonly Return[],
  line: Header,
  t: number,
): Station {
  const present = inStage(items, stage);
  // A ticket waiting for the planner is in the stage, but nothing is being done to it: it queues, and the station
  // stays idle rather than look busy with nobody at work.
  const queued = present.filter((item) => item.queued);
  const here = present.filter((item) => !item.queued);
  const held = here.filter((item) => item.hold);
  const failed = here.filter((item) => item.failure?.stage === stage && !item.hold);
  const left = leavers(items, stage);
  const today = left.filter(({ at }) => at >= startOfDay(t)).length;
  // At a spend cap, triage takes no reports until it resets. The senses' tickets need no model, so they still open.
  const capped = stage === 'triage' ? line.capped : undefined;

  let status: Status;
  if (line.stopped !== undefined) status = 'blocked';
  else if (failed.length) status = 'failed';
  else if (held.length || capped) status = 'blocked';
  else if (returns.some((r) => r.from === stage && t - r.at <= RETURNING_MS)) status = 'returning';
  else if (here.length) status = 'working';
  else if (left.some(({ at }) => t - at <= PASSING_MS)) status = 'passing';
  else status = 'idle';

  const canary = here.find((item) => item.canary)?.canary;
  let figure: string;
  if (held.length) figure = `${held.length} ${stage === 'gates' ? 'held' : 'waiting'}`;
  else if (stage === 'release' && canary) figure = canary.weight ? `${canary.weight}%` : 'starting';
  else if (here.length) figure = count(here.length, NOUNS[stage]);
  else if (queued.length) figure = `${queued.length} waiting`;
  else figure = today ? `${today} today` : 'none';
  return { stage, status, figure, queued: queued.length, cappedUntil: capped?.resets };
}

/**
 * What a station shows while the line draws one of its returns: "sending back", unless it has failed or waits on
 * a human, which outrank a return (the rules above).
 */
export function whileSending(status: Status, sending: boolean): Status {
  return sending && status !== 'failed' && status !== 'blocked' ? 'returning' : status;
}

/** Work sent back upstream in the last day, newest first. */
export function returnsAt(events: readonly PublicEvent[], t: number): Return[] {
  return events
    .flatMap((event) =>
      event.type === 'work.returned' && event.work_item && t - Date.parse(event.ts) <= RETURNS_MS
        ? [
            {
              item: event.work_item,
              from: event.payload.from,
              to: event.payload.to,
              text: event.summary,
              at: Date.parse(event.ts),
            },
          ]
        : [],
    )
    .reverse();
}

/** A row's note for an item in a stage now: what it waits for, or the last thing that happened to it there. */
function noteOf(item: ItemState, stage: Stage): string {
  if (item.queued) return 'Waiting for the planner';
  // Only Martin asks for improvements, so a visitor's suggestion waits for him.
  if (item.hold && item.kind === 'visitor-report') return 'Needs you · parked for Martin';
  return item.hold ? item.hold.reason : (item.latest[stage]?.summary ?? '');
}

/** Rows by work-item number, the newest first. */
const newestFirst = (a: PanelRow, b: PanelRow) => Number(b.item) - Number(a.item);

/** What a stage panel lists: the items in the stage now, then what left it today. */
export function panel(
  stage: Stage,
  items: readonly ItemState[],
  events: readonly PublicEvent[],
  line: Header,
  t: number,
): StagePanel {
  const present = inStage(items, stage);
  const now = present.map(
    (item): PanelRow => ({
      item: item.number,
      title: item.title,
      note: noteOf(item, stage),
      tone: item.hold || item.failure ? 'attn' : item.queued ? 'faint' : 'signal',
      at: item.lastAt,
    }),
  );
  const done = leavers(items, stage)
    .filter(({ at }) => at >= startOfDay(t))
    .map(
      ({ item, at }): PanelRow => ({
        item: item.number,
        title: item.title,
        note: stage === item.stage ? (CLOSED_NOTE[item.outcome] ?? 'passed') : `passed on to ${item.stage ?? ''}`,
        tone: stage === 'verify' ? 'ok' : 'faint',
        at,
      }),
    );
  const triage = stage === 'triage';
  return {
    stage,
    // What is in the stage, then what left it today, each newest first: the store numbers work items in order.
    rows: [...now.sort(newestFirst), ...done.sort(newestFirst)],
    senses: triage ? senseCounts(items, events) : undefined,
    caps: triage ? line.caps.filter((spell) => spell.cleared === undefined || spell.cleared >= startOfDay(t)) : [],
    queued: present.filter((item) => item.queued).length,
  };
}

/**
 * What each sense has sent Triage, from events alone: every signal triage made an event of (one that opened a
 * ticket, or the first time a sense added its evidence to one), and the tickets each sense's signal opened. A sense
 * seeing an open ticket's problem again is counted by the inbox, which is not events, so not here.
 */
export function senseCounts(items: readonly ItemState[], events: readonly PublicEvent[]): SenseCount[] {
  const counts = new Map<Sense, SenseCount>(
    SENSES.map((sense) => [
      sense,
      {
        sense,
        signals: 0,
        tickets: 0,
        routes: sense === 'report' ? { quarantined: 0, parked: 0, closed: 0, joined: 0 } : undefined,
      },
    ]),
  );
  const routes = counts.get('report')?.routes;
  for (const event of events) {
    if (event.type === 'signal.received') {
      const found = counts.get(event.payload.sense);
      if (found) found.signals += 1;
    }
    if (event.type === 'judgement.made' && routes) {
      if (event.payload.route === 'quarantine') routes.quarantined += 1;
      if (event.payload.route === 'park') routes.parked += 1;
      if (event.payload.route === 'discard') routes.closed += 1;
      if (event.payload.route === 'repeat') routes.joined += 1;
    }
  }
  for (const item of items) {
    if (!item.ticket) continue;
    const opener = item.events.find((event) => event.type === 'signal.received');
    const found = opener?.type === 'signal.received' ? counts.get(opener.payload.sense) : undefined;
    if (found) found.tickets += 1;
  }
  return [...counts.values()];
}
