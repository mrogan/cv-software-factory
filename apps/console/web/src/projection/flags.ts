/**
 * The feature flags, as everyone sees them (milestone 7, task 16): each flag an improvement ships behind, the stage
 * Martin set it at, and what each stop of its slider would take now, judged by the rules the admin service refuses a
 * move by (`policy/flag-moves.ts`), so the console says why a stop can't be taken in the service's own words.
 *
 * A flag's stage is read from Martin's `flag.staged` events, as the admin service records each move, and Verify's
 * `flag.compared`; which flag is whose, from the latest spec of each improvement. The service judges a move from the
 * stage `flags` holds, and refuses one that the events have run behind: the console only draws.
 *
 * A flag shows once its release is out, or once Martin has staged it. Waiting for Martin to widen, it is a card in
 * Needs you, but while Verify is still comparing its two sides at Share.
 */
import type { PayloadOf, PublicEvent } from '@software-factory/events';
import {
  type Around,
  type Comparison,
  comparisonOf,
  type FlagNow,
  type FlagRecord,
  flagsFrom,
  type Move,
  movesOf,
  sameStage,
  turnedOffFromEveryone,
} from '../../../../../policy/flag-moves.ts';
import { type Share, STAGES, type Stage, type StageName } from '../../../../../policy/flags.ts';
import { shortVersion } from '../format.ts';
import type { ItemState } from './items.ts';
import { waited } from './needs.ts';
import { inFlight, type Release } from './release.ts';

export type { Comparison, Move } from '../../../../../policy/flag-moves.ts';
export type { Share, Stage, StageName } from '../../../../../policy/flags.ts';

/** A stage's name, as the console says it everywhere. */
export const STAGE_NAME: Record<StageName, string> = {
  off: 'Off',
  checks: 'Checks',
  preview: 'Preview',
  share: 'Share',
  everyone: 'Everyone',
};

/** Who gets a flag on at each stage, in the README's words (the design system's "The stages"). */
export function stageSays(stage: Stage): string {
  switch (stage.stage) {
    case 'off':
      return 'Off for everyone, a preview too. The code is in the app, and nothing runs it.';
    case 'checks':
      return 'On for the factory’s own checks alone: the probes, the crawler and the canary’s journeys. Nobody else sees it.';
    case 'preview':
      return 'On for the checks, and for anyone who asks to preview it, in their own browser.';
    case 'share':
      return `On for the checks, a preview, and ${stage.share}% of the traffic generator’s requests, so Verify can compare the two sides. Visitors still don’t see it.`;
    case 'everyone':
      return 'On for every visitor.';
  }
}

/** One stop of a flag's slider: its stage (Share at the share it shows), and the move there, judged. */
export interface Stop {
  stage: StageName;
  to: Stage;
  move: Move;
  /** Passed (filled), where it stands (ringed), or ahead (hollow). */
  place: 'done' | 'now' | 'ahead';
}

/** Verify's latest comparison of a flag at Share since Martin last moved it, with when. */
export type Compared = PayloadOf<'flag.compared'> & { at: number };

export interface FlagRow {
  name: string;
  /** The work item it ships on: the improvement whose spec names it, or the one it was staged on. */
  workItem: string;
  title: string;
  /** Where it stands: off until Martin stages it. */
  stage: Stage;
  /** The share its Share stop shows: the one it is at, or was last at, or half and half. */
  share: Share;
  stops: Stop[];
  /** Every stage it could go to, Share at each share, judged. */
  moves: Move[];
  /** At Share, Verify's comparison as it stands. */
  comparison: Comparison | undefined;
  compared: Compared | undefined;
  /** Turned off from Everyone: it may go straight back. */
  backOn: boolean;
  /** Turned off by Martin, rather than never widened. */
  turnedOff: boolean;
  /**
   * Turned off before everyone had it, and its work item closed as turned off (the line closes it once Martin turns
   * the flag off): folded under Turned off and closed. One turned off from Everyone may go straight back, so it stays.
   */
  closed: boolean;
  /** Its work item is still open: turning the flag off closes it. */
  open: boolean;
  /** When it came to stand where it does: Martin's last move, or its release. */
  since: number;
  /** The release that shipped it, with the flag off. */
  released: { version: string; at: number } | undefined;
}

/** A flag waiting for Martin to widen it: its card in Needs you. */
export interface FlagNeed {
  flag: string;
  workItem: string;
  title: string;
  /** "Ready to widen", "Shipped behind its flag" (released, still off), or "Turned off". */
  kicker: string;
  stage: Stage;
  waited: string;
  since: number;
  /** The one thing to know before widening, in a sentence. */
  evidence: string;
  /** The next stage, judged: Widen to it, or why it can't be taken now. */
  widen: Move;
  /** Turn off, when the flag is on for anyone. */
  turnOff: Move | undefined;
}

export interface FlagsView {
  /** The flags in the app, oldest work item first. */
  flags: FlagRow[];
  /** Turned off before everyone had them, their work items closed. */
  closed: FlagRow[];
  /** Each flag waiting for Martin to widen it, oldest first. */
  needs: FlagNeed[];
}

/** The flag an improvement's latest spec names, if it is one. */
export function specFlag(item: ItemState): string | undefined {
  if (item.kind !== 'improvement') return undefined;
  const spec = item.events.findLast((event) => event.type === 'spec.written');
  return spec?.type === 'spec.written' ? spec.payload.flag : undefined;
}

/** The events a flag's state is read from: Martin's moves, which only his roles can append, and Verify's comparisons. */
function records(events: readonly PublicEvent[]): FlagRecord[] {
  return events.flatMap((event): FlagRecord[] => {
    if (event.type === 'flag.staged' && event.actor === 'martin' && event.work_item) {
      const { flag, from, to } = event.payload;
      return [{ type: 'flag.staged', flag, workItem: event.work_item, from, to }];
    }
    if (event.type === 'flag.compared' && event.actor !== 'martin' && event.actor !== 'visitor') {
      const { flag, share, outcome } = event.payload;
      return [{ type: 'flag.compared', flag, share, outcome }];
    }
    return [];
  });
}

/** When an item's release that went to all the traffic did, and its version: the first one, with the flag off. */
function releasedOf(item: ItemState): FlagRow['released'] {
  const promoted = item.events.find((event) => event.type === 'release.promoted');
  return promoted?.type === 'release.promoted'
    ? { version: promoted.payload.version, at: Date.parse(promoted.ts) }
    : undefined;
}

/** Where a flag stands on its own work item's events alone: what the card and the item's outcome need. */
export function itemFlag(item: ItemState): { name: string; now: FlagNow; built: boolean } | undefined {
  const name = specFlag(item);
  if (!name) return undefined;
  const now = flagsFrom(
    records(item.events).filter((record) => record.flag === name),
    { [name]: item.number },
    item.outcome === 'turned-off' ? [item.number] : [],
  )[name] ?? { stage: { stage: 'off' } };
  return { name, now, built: Boolean(releasedOf(item)) || now.last !== undefined };
}

/**
 * Whether an open improvement waits for Martin to widen its flag: built, short of Everyone, and not while Verify is
 * still comparing its two sides at Share. Its outcome is then Needs you.
 */
export function flagWaits(item: ItemState): boolean {
  const flag = itemFlag(item);
  // As its card in Needs you: only once its release is out.
  if (!flag || !releasedOf(item)) return false;
  const { now } = flag;
  return now.stage?.stage !== 'everyone' && comparisonOf(now) !== 'comparing';
}

/** The latest of a flag's moves on the events, and the comparisons since it. */
function latest(events: readonly PublicEvent[], flag: string) {
  let staged: (PublicEvent & { type: 'flag.staged' }) | undefined;
  let compared: Compared | undefined;
  for (const event of events) {
    if (event.type === 'flag.staged' && event.actor === 'martin' && event.payload.flag === flag) {
      staged = event;
      compared = undefined;
    }
    if (event.type === 'flag.compared' && event.actor !== 'martin' && event.payload.flag === flag) {
      compared = { ...event.payload, at: Date.parse(event.ts) };
    }
  }
  return { staged, compared };
}

/** The share a flag's Share stop shows: the one it is at or last went to, or 50, which fills both sides soonest. */
function shareOf(events: readonly PublicEvent[], flag: string, now: FlagNow): Share {
  if (now.stage?.stage === 'share') return now.stage.share;
  const last = events.findLast(
    (event) =>
      event.type === 'flag.staged' &&
      event.actor === 'martin' &&
      event.payload.flag === flag &&
      event.payload.to.stage === 'share',
  );
  return last?.type === 'flag.staged' && last.payload.to.stage === 'share' ? last.payload.to.share : 50;
}

const rank = (stage: StageName) => STAGES.indexOf(stage);

/** A stage at a share, Share at the one given. */
export const stageAt = (stage: StageName, share: Share): Stage => (stage === 'share' ? { stage, share } : { stage });

/** The move to a stage among a flag's judged moves. */
export const moveTo = (moves: readonly Move[], to: Stage): Move | undefined =>
  moves.find((move) => sameStage(move.to, to));

/** What a move into Share waits for: another flag there, and the canary in flight, as the samples' releases say. */
function aroundOf(flags: Record<string, FlagNow>, flag: string, shipped: readonly Release[]): Around {
  const atShare = Object.entries(flags).find(([name, now]) => name !== flag && now.stage?.stage === 'share')?.[0];
  const flight = inFlight(shipped);
  return {
    ...(atShare && { atShare }),
    // A dry run sends nothing to a canary, so no traffic of it mixes the two sides.
    ...(flight && !flight.dryRun && { canary: { version: shortVersion(flight.version), weight: flight.weight } }),
  };
}

/** The flags, as their events had them by now. */
export function flagsView(
  seen: readonly PublicEvent[],
  items: readonly ItemState[],
  shipped: readonly Release[],
  t: number,
): FlagsView {
  const byNumber = new Map(items.map((item) => [item.number, item]));
  // The flag each improvement's latest spec names; the work item of the latest such spec wins, as the admin service reads it.
  const named: Record<string, string> = {};
  const specs = items.flatMap((item) => {
    const flag = specFlag(item);
    const spec = item.events.findLast((event) => event.type === 'spec.written');
    return flag && spec ? [{ flag, number: item.number, seq: spec.seq }] : [];
  });
  for (const { flag, number } of specs.sort((a, b) => a.seq - b.seq)) named[flag] = number;
  const turnedOff = items.flatMap((item) => (item.outcome === 'turned-off' ? [item.number] : []));
  const all = flagsFrom(records(seen), named, turnedOff);
  const rows: FlagRow[] = [];
  for (const [name, now] of Object.entries(all)) {
    const workItem = now.workItem ?? now.stagedOn;
    const item = workItem ? byNumber.get(workItem) : undefined;
    if (!workItem || !item) continue;
    const released = releasedOf(item);
    // A flag shows once its release is out, or once Martin has moved it.
    if (!released && !now.last) continue;
    const stage = now.stage ?? { stage: 'off' };
    const share = shareOf(seen, name, now);
    const moves = movesOf(name, now, aroundOf(all, name, shipped));
    const { staged, compared } = latest(seen, name);
    const at = rank(stage.stage);
    const backOn = turnedOffFromEveryone(now);
    const turnedOff = stage.stage === 'off' && now.last?.to.stage === 'off';
    rows.push({
      name,
      workItem,
      title: item.title,
      stage,
      share,
      stops: STAGES.map((s, i): Stop => {
        const to = stageAt(s, share);
        return {
          stage: s,
          to,
          move: moveTo(moves, to) ?? { to, action: undefined },
          place: i < at ? 'done' : i === at ? 'now' : 'ahead',
        };
      }),
      moves,
      comparison: comparisonOf(now),
      compared: compared && stage.stage === 'share' && compared.share === stage.share ? compared : undefined,
      backOn,
      turnedOff,
      closed: stage.stage === 'off' && item.outcome === 'turned-off' && !backOn,
      open: item.closedAt === undefined,
      since: staged ? Date.parse(staged.ts) : (released?.at ?? item.openedAt),
      released,
    });
  }
  const order = (a: FlagRow, b: FlagRow) =>
    (byNumber.get(a.workItem)?.openedAt ?? 0) - (byNumber.get(b.workItem)?.openedAt ?? 0);
  const flags = rows.filter((row) => !row.closed).sort(order);
  return {
    flags,
    closed: rows.filter((row) => row.closed).sort(order),
    needs: flags
      .filter((row) => {
        const item = byNumber.get(row.workItem);
        return (
          item?.closedAt === undefined &&
          row.stage.stage !== 'everyone' &&
          row.comparison !== 'comparing' &&
          row.released
        );
      })
      .map((row) => needOf(row, t))
      .sort((a, b) => a.since - b.since),
  };
}

/** The stage after a flag's, which Widen to takes it to: back to Everyone for a flag turned off from there. */
function nextOf(row: FlagRow): Stage {
  if (row.backOn) return { stage: 'everyone' };
  const next = STAGES[rank(row.stage.stage) + 1] ?? 'everyone';
  return stageAt(next, row.stage.stage === 'share' ? row.share : 50);
}

const percentOf = (rate: number | null) => (rate === null ? 'none' : `${(rate * 100).toFixed(2)}%`);

/** A comparison's figures in a sentence: "errors 0.97% and 1.01%, p99 41 ms and 40 ms, over 412 and 398 requests". */
export function comparedWords({ sides: { on, off } }: Compared): string {
  const p99 = (ms: number | null) => (ms === null ? 'none' : `${ms} ms`);
  return `errors ${percentOf(on.errorRate)} and ${percentOf(off.errorRate)}, p99 ${p99(on.p99Ms)} and ${p99(off.p99Ms)}, over ${on.requests} and ${off.requests} requests`;
}

function needOf(row: FlagRow, t: number): FlagNeed {
  const next = nextOf(row);
  const widen = moveTo(row.moves, next) ?? { to: next, action: undefined };
  const { stage } = row;
  const evidence =
    stage.stage === 'off'
      ? row.turnedOff
        ? `Turned off. ${row.backOn ? 'It was on for everyone, so it may go straight back.' : 'Widening it again starts at Checks.'}`
        : `Released in ${row.released ? shortVersion(row.released.version) : 'its release'} with ${row.name} off. At Checks, only the factory’s own checks see it on.`
      : stage.stage === 'checks'
        ? 'Only the factory’s own checks see it on. No probe knows a new feature: judge the pages off and on before you widen.'
        : stage.stage === 'preview'
          ? 'Anyone who asks can preview it, in their own browser, with only the cookie they asked for.'
          : row.compared
            ? `Flag on against off, on the traffic generator’s requests: ${comparedWords(row.compared)}. ${row.compared.outcome === 'passed' ? 'Within the canary’s thresholds.' : (row.compared.reason ?? 'It failed the canary’s thresholds.')}`
            : stageSays(stage);
  return {
    flag: row.name,
    workItem: row.workItem,
    title: row.title,
    kicker: stage.stage !== 'off' ? 'Ready to widen' : row.turnedOff ? 'Turned off' : 'Shipped behind its flag',
    stage,
    waited: waited(t - row.since),
    since: row.since,
    evidence,
    widen,
    turnOff: stage.stage === 'off' ? undefined : moveTo(row.moves, { stage: 'off' }),
  };
}
