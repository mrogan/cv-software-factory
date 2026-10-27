/**
 * Which stage a feature flag may move to from where it stands, and why one cannot be taken now (milestone 7, task 16).
 * Martin sets each flag's stage from the console's Controls; the admin service judges the move here, then writes it to
 * `flags` with `policy/flags.ts`. The console draws each stop of a flag's slider from the same judgement, so it says
 * why a stop cannot be taken before Martin chooses it, in the words the admin service refuses it with.
 *
 * - **Widening** is one stage at a time, so Verify can check each, but Preview may be skipped (Checks to Share).
 *   Off to Checks shows the change to nobody but the factory's own checks, and is the one widening that asks for no
 *   passkey (`flag.to-checks` in the access table); every other is `flag.widen`, with it. A larger share is a widening.
 * - **Turning back on**: a flag turned off from Everyone may go straight back to Everyone, with the passkey
 *   (`flag.back-on`). Any other flag that is off widens from Checks, but one whose work item the line closed as turned
 *   off: that stays off, its code in the app, and only a flag turned off from Everyone goes back on.
 * - **Narrowing** may go to any lower stage, or a smaller share, and **Off** from any stage, each with no passkey: they
 *   only tighten, so neither is refused, but for narrowing into Share, which is held as widening into it is. A flag
 *   once staged can always be turned off, on the work item it was staged on.
 * - **Share** is refused while a canary is in flight, whose two versions would mix the two sides, or can't be told to
 *   be, and while another flag is at Share: one at a time, so each comparison varies one thing.
 * - **Everyone** waits for Verify's comparison of the flag at Share (`flag.compared`) since Martin last set its stage:
 *   refused while it is still comparing, and when it failed.
 * - Only a flag an improvement's spec names is staged here, so each move is on that improvement's work item.
 *
 * What the access table makes of each move (`flagAction`) is decided from the stage `flags` holds, never the
 * request's word, so the admin service asks for the passkey again by what a move does, and the line counts each
 * `flag.staged` as the security event it is, from its stored stages alone.
 *
 * Human-owned: see `README.md`.
 */
import type { FlagActionName, FlagComparison } from '../packages/events/src/vocabulary.ts';
import { EVERY_STAGE, SHARES, type Share, STAGES, type Stage, type StageName } from './flags.ts';

/** The access table's action a move is (`policy/access.ts`). */
export type FlagAction = FlagActionName;

/** Where a flag stands, as a move of it is judged. */
export interface FlagNow {
  /** Its stage: off when `flags` does not name it, and null when `flags` holds it in no stage's shape. */
  stage: Stage | null;
  /** The work item whose improvement's spec names it: none, and it is not staged here, but turned off. */
  workItem?: string;
  /** The work item it was last staged on, if it has been: one turned off is recorded there. */
  stagedOn?: string;
  /** Martin's last move of it (its latest `flag.staged`), which says what a flag that is off was turned off from. */
  last?: { from: Stage | null; to: Stage };
  /** Verify's latest comparison of it at the share stage since that move, if there is one. */
  compared?: { share: Share; outcome: FlagComparison };
  /** The work item it was last staged on closed as turned off: it stays off, but for going straight back to Everyone. */
  closed?: boolean;
}

/** What else a move into Share is judged against. */
export interface Around {
  /** Another flag at Share, by name, if one is. */
  atShare?: string;
  /** The canary in flight, if one is: its version and its weight; `unknown` when whether one is can't be told. */
  canary?: { version: string; weight: number } | 'unknown';
}

/** Where Verify's comparison of a flag at Share stands: still comparing until it has judged since the last move. */
export type Comparison = 'comparing' | FlagComparison;

/** A move to a stage, judged: its action (none when the flag is there already), and why it can't be taken now. */
export interface Move {
  to: Stage;
  action: FlagAction | undefined;
  refused?: string;
}

/** A stage in the console's words: "Share 50%". */
export const stageWords = (stage: Stage | null): string => {
  if (stage === null) return 'outside every stage';
  const name = `${stage.stage[0]?.toUpperCase()}${stage.stage.slice(1)}`;
  return stage.stage === 'share' ? `${name} ${stage.share}%` : name;
};

const rank = (stage: StageName) => STAGES.indexOf(stage);
/** Whether two stages are the same, a share the same share; none, outside every stage, is the same as none. */
export const sameStage = (a: Stage | null, b: Stage | null): boolean =>
  a === null || b === null
    ? a === b
    : a.stage === b.stage && (a.stage !== 'share' || (b.stage === 'share' && a.share === b.share));

/**
 * The access table's action a move from one stage to another is, or undefined when it moves nothing. A flag in no
 * stage's shape is taken as wide as it might be: any move but Off widens it.
 */
export function flagAction(from: Stage | null, to: Stage): FlagAction | undefined {
  if (to.stage === 'off') return from?.stage === 'off' ? undefined : 'flag.off';
  if (from === null) return 'flag.widen';
  if (sameStage(from, to)) return undefined;
  if (from.stage === 'share' && to.stage === 'share') return to.share > from.share ? 'flag.widen' : 'flag.narrow';
  if (rank(to.stage) < rank(from.stage)) return 'flag.narrow';
  if (from.stage === 'off' && to.stage === 'checks') return 'flag.to-checks';
  if (from.stage === 'off' && to.stage === 'everyone') return 'flag.back-on';
  return 'flag.widen';
}

/** Verify's comparison of a flag at Share, as it stands: undefined when the flag is not at Share. */
export function comparisonOf(now: FlagNow): Comparison | undefined {
  if (now.stage?.stage !== 'share') return undefined;
  if (!now.compared || now.compared.share !== now.stage.share) return 'comparing';
  return now.compared.outcome;
}

/** Whether a flag that is off was turned off from Everyone, by Martin's last move of it, and may go straight back. */
export const turnedOffFromEveryone = (now: FlagNow): boolean =>
  now.stage?.stage === 'off' && now.last?.to.stage === 'off' && now.last.from?.stage === 'everyone';

/** A move of a flag to a stage, judged against where it stands and what is around it. */
export function moveOf(flag: string, now: FlagNow, to: Stage, around: Around = {}): Move {
  const action = flagAction(now.stage, to);
  const refused = refusalOf(flag, now, to, action, around);
  return { to, action, ...(refused && { refused }) };
}

/** Every stop of a flag's slider, each share of Share its own, judged: what the console draws. */
export function movesOf(flag: string, now: FlagNow, around: Around = {}): Move[] {
  return EVERY_STAGE.map((to) => moveOf(flag, now, to, around));
}

function refusalOf(
  flag: string,
  now: FlagNow,
  to: Stage,
  action: FlagAction | undefined,
  around: Around,
): string | undefined {
  if (to.stage === 'share' && !(SHARES as readonly number[]).includes(to.share)) {
    return `A share is ${SHARES.slice(0, -1).join(', ')} or ${SHARES.at(-1)}%.`;
  }
  if (action === undefined) return `${flag} is at ${stageWords(to)} already.`;
  // A flag once staged can always be turned off, on the work item it was staged on, though no spec names it now.
  if (action === 'flag.off' && now.stagedOn) return undefined;
  if (!now.workItem) {
    return `No improvement's spec names ${flag}: only a flag an improvement ships behind is staged here.`;
  }
  // Off only ever tightens: the kill switch is never refused, for a flag on a work item.
  if (action === 'flag.off') return undefined;
  const from = now.stage;
  if (from === null) {
    return `${flag} is set in flagd outside every stage: turn it off first, then widen it a stage at a time.`;
  }
  if (now.closed && from.stage === 'off' && action !== 'flag.back-on') {
    return `${flag} was turned off, and #${now.stagedOn} closed as turned off: it stays off. Only a flag turned off from Everyone goes straight back on.`;
  }
  if (action === 'flag.back-on' && !turnedOffFromEveryone(now)) {
    return 'Only a flag turned off from Everyone goes straight back to it: from Off, Checks comes first.';
  }
  const skips = rank(to.stage) - rank(from.stage) > 1;
  const skipsPreview = from.stage === 'checks' && to.stage === 'share';
  if (action === 'flag.widen' && skips && !skipsPreview) {
    return 'One stage at a time, so Verify can check each: Preview is the only one that can be skipped.';
  }
  if (to.stage === 'share' && from.stage !== 'share') {
    if (around.atShare && around.atShare !== flag) {
      return `${around.atShare} is at Share: one flag at a time, so each comparison varies one thing.`;
    }
    if (around.canary === 'unknown') {
      return "Whether a canary is in flight can't be told now, and its two versions would mix the two sides: look again in a moment.";
    }
    if (around.canary) {
      return `${around.canary.version} is at ${around.canary.weight}%, and its two versions would mix the two sides. Share can be taken once it ends.`;
    }
  }
  if (to.stage === 'everyone' && action === 'flag.widen') {
    const comparison = comparisonOf(now);
    if (comparison === 'comparing') {
      return 'Verify is still comparing the two sides at Share: Everyone can be taken once the comparison has passed.';
    }
    if (comparison === 'failed') {
      return "Verify's comparison at Share failed: Everyone can't be taken. Narrow it, or turn it off.";
    }
  }
  return undefined;
}

/** One of the events a flag's state is read from, as each reader has it, oldest first. */
export type FlagRecord =
  | { type: 'flag.staged'; flag: string; workItem: string; from: Stage | null; to: Stage }
  | { type: 'flag.compared'; flag: string; share: Share; outcome: FlagComparison };

/**
 * Each flag as Martin's stages and Verify's comparisons tell it, from their events oldest first (only those Martin's
 * roles appended, and Verify's, the line's), with the flags improvements' specs name and their work items, and the work
 * items closed as turned off: what the console reads where the admin service reads `flags` itself. A flag named by a
 * spec and never staged is off.
 */
export function flagsFrom(
  records: readonly FlagRecord[],
  named: Readonly<Record<string, string>> = {},
  closed: readonly string[] = [],
): Record<string, FlagNow> {
  const flags: Record<string, FlagNow> = {};
  for (const [flag, workItem] of Object.entries(named)) flags[flag] = { stage: { stage: 'off' }, workItem };
  for (const record of records) {
    if (record.type === 'flag.staged') {
      const { flag, workItem, from, to } = record;
      // A move clears the comparison before it: Verify compares the flag as it stands.
      const spec = named[flag];
      flags[flag] = {
        stage: to,
        ...(spec && { workItem: spec }),
        stagedOn: workItem,
        last: { from, to },
        ...(closed.includes(workItem) && { closed: true }),
      };
    } else {
      const now = flags[record.flag] ?? { stage: { stage: 'off' } };
      flags[record.flag] = { ...now, compared: { share: record.share, outcome: record.outcome } };
    }
  }
  return flags;
}
