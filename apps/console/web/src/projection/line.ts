/**
 * The line at time t: whether it runs, each station's state and figure, the returns waiting to be drawn, and what
 * each stage panel lists.
 */
import type { Autonomy, PublicEvent, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import type { ItemState } from './items.ts';

export type Status = 'idle' | 'working' | 'returning' | 'passing' | 'blocked' | 'failed';

/** How long a return keeps its sender "sending back". */
export const RETURNING_MS = 5 * 60_000;
/** How long a stage reads "passed" after an item leaves it, with nothing else in it. */
export const PASSING_MS = 15 * 60_000;
/** How far back returns are kept, to be drawn one at a time. */
export const RETURNS_MS = 24 * 3_600_000;

export interface Header {
  running: boolean;
  autonomy: Autonomy | undefined;
  /** Why the line was stopped, when it is. */
  stopped: string | undefined;
}

export interface Station {
  stage: Stage;
  status: Status;
  /** One short figure for the caption, such as "2 PRs" or "25%". */
  figure: string;
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

export interface StagePanel {
  stage: Stage;
  rows: PanelRow[];
}

export function header(events: readonly PublicEvent[]): Header {
  let state: Header = { running: false, autonomy: undefined, stopped: undefined };
  for (const event of events) {
    if (event.type === 'line.started') state = { running: true, autonomy: event.payload.autonomy, stopped: undefined };
    if (event.type === 'line.stopped') state = { ...state, running: false, stopped: event.payload.reason };
  }
  return state;
}

/** Items in a stage now: open, and that stage their latest. */
const inStage = (items: readonly ItemState[], stage: Stage) =>
  items.filter((item) => item.closedAt === undefined && item.stage === stage);

/** Items that left a stage for a later one, or closed in it successfully, and when. */
function leavers(items: readonly ItemState[], stage: Stage): { item: ItemState; at: number }[] {
  return items.flatMap((item) => {
    const left = item.visits[stage]?.leftAt;
    if (left === undefined) return [];
    const closedHere = item.closedAt !== undefined && item.stage === stage;
    if (closedHere && item.outcome !== 'verified' && !(item.outcome === 'closed' && !item.failure)) return [];
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
) {
  const here = inStage(items, stage);
  const held = here.filter((item) => item.hold);
  const failed = here.filter((item) => item.failure?.stage === stage && !item.hold);
  const left = leavers(items, stage);
  const today = left.filter(({ at }) => at >= startOfDay(t)).length;

  let status: Status;
  if (line.stopped !== undefined) status = 'blocked';
  else if (failed.length) status = 'failed';
  else if (held.length) status = 'blocked';
  else if (returns.some((r) => r.from === stage && t - r.at <= RETURNING_MS)) status = 'returning';
  else if (here.length) status = 'working';
  else if (left.some(({ at }) => t - at <= PASSING_MS)) status = 'passing';
  else status = 'idle';

  const canary = here.find((item) => item.canary)?.canary;
  let figure: string;
  if (held.length) figure = `${held.length} ${stage === 'gates' ? 'held' : 'waiting'}`;
  else if (stage === 'release' && canary) figure = canary.weight ? `${canary.weight}%` : 'starting';
  else if (here.length) figure = count(here.length, NOUNS[stage]);
  else figure = today ? `${today} today` : 'none';
  return { stage, status, figure } satisfies Station;
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

/** What a stage panel lists: the items in the stage now, then what left it today. */
export function panel(stage: Stage, items: readonly ItemState[], t: number): StagePanel {
  const now = inStage(items, stage).map((item): PanelRow => {
    const latest = item.latest[stage];
    return {
      item: item.number,
      title: item.title,
      note: item.hold ? item.hold.reason : (latest?.summary ?? ''),
      tone: item.hold || item.failure ? 'attn' : 'signal',
      at: item.lastAt,
    };
  });
  const done = leavers(items, stage)
    .filter(({ at }) => at >= startOfDay(t))
    .sort((a, b) => b.at - a.at)
    .map(
      ({ item, at }): PanelRow => ({
        item: item.number,
        title: item.title,
        note:
          stage === 'verify' ? 'verified' : `passed ${stage === item.stage ? '' : 'on to '}${item.stage ?? ''}`.trim(),
        tone: stage === 'verify' ? 'ok' : 'faint',
        at,
      }),
    );
  return { stage, rows: [...now, ...done] };
}
