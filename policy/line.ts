/**
 * Martin's controls of the line, within policy: the autonomy level, whether agents take new work, whether low-risk
 * changes merge by themselves, and what the line takes, as he chose them in the console (`controls.changed`). This is
 * the one check: the line, the admin service and the console each turn the latest controls event into the controls in
 * force with `controlsInForce`, so all three agree on what is in force.
 *
 * Controls are checked where they are read, not only where they are written: whatever an event says, anything outside
 * policy is not in force, and policy's default is, control by control. A take that is not in force is none: the line's
 * own default (`LINE_TAKE`, `LINE_ONLY`) is in force then, as it is before Martin sets one.
 *
 * And which of the access table's actions a change is (`policy/access.ts`), so the admin service asks for the passkey
 * again for one that loosens, and the line counts each as a security event, from the change alone.
 *
 * Human-owned: see `README.md`.
 */
import { AUTONOMY, type Autonomy, type TakeKind } from '../packages/events/src/vocabulary.ts';

/** The most work items "The next few" may take: the console's field allows 1 to this. */
export const TAKE = { most: 20 } as const;

/** What the line takes, as the controls hold it. */
export type Take =
  | { kind: 'every' }
  /** The next `count` work items onto the line, counted from `since`, when Martin chose the next few. */
  | { kind: 'next-few'; count: number; since: string }
  | { kind: 'just-one'; workItem: string };

/** The line's controls. */
export interface Controls {
  autonomy: Autonomy;
  newWork: boolean;
  autoMerge: boolean;
  /** None: no take set, and the line's own default is in force. */
  take: Take | null;
}

/** The controls in force, and the fields the latest event gave that policy does not allow, or left out. */
export interface ControlsInForce extends Controls {
  outside: string[];
}

/**
 * Before Martin sets any: Supervised (every change waits for him, as it does until approval routing comes, whatever
 * the level), agents taking new work, no auto-merge, and no take set.
 */
export const DEFAULT_CONTROLS: Controls = { autonomy: 'supervised', newWork: true, autoMerge: false, take: null };

/** One control changed, with its value before and after. */
export type ControlChange =
  | { control: 'autonomy'; before: Autonomy; after: Autonomy }
  | { control: 'new-work'; before: boolean; after: boolean }
  | { control: 'auto-merge'; before: boolean; after: boolean }
  | { control: 'take'; before: Take | null; after: Take };

/** The access table's action a change is. */
export type ControlAction =
  | 'autonomy.loosen'
  | 'autonomy.tighten'
  | 'new-work.on'
  | 'new-work.off'
  | 'auto-merge.on'
  | 'auto-merge.off'
  | 'take.widen'
  | 'take.narrow';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const WORK_ITEM = /^[1-9]\d{0,8}$/;

/** A take if it is one within policy, or undefined. */
export function takeOf(value: unknown): Take | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.kind as TakeKind) {
    case 'every':
      return { kind: 'every' };
    case 'next-few': {
      const { count, since } = value;
      const within = typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= TAKE.most;
      const when = typeof since === 'string' && Number.isFinite(Date.parse(since));
      return within && when ? { kind: 'next-few', count, since } : undefined;
    }
    case 'just-one':
      return typeof value.workItem === 'string' && WORK_ITEM.test(value.workItem)
        ? { kind: 'just-one', workItem: value.workItem }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The controls in force, from the latest controls event's payload (or none). The payload is read as anything at all:
 * what is outside policy, or not there, is not in force, and policy's default is.
 */
export function controlsInForce(chosen?: unknown): ControlsInForce {
  if (!isRecord(chosen)) return { ...DEFAULT_CONTROLS, outside: [] };
  const outside: string[] = [];
  const autonomy = (AUTONOMY as readonly unknown[]).includes(chosen.autonomy)
    ? (chosen.autonomy as Autonomy)
    : DEFAULT_CONTROLS.autonomy;
  if (autonomy !== chosen.autonomy) outside.push('autonomy');
  const flag = (field: 'newWork' | 'autoMerge') => {
    if (typeof chosen[field] === 'boolean') return chosen[field] as boolean;
    outside.push(field);
    return DEFAULT_CONTROLS[field];
  };
  const newWork = flag('newWork');
  const autoMerge = flag('autoMerge');
  const take = chosen.take === null ? null : (takeOf(chosen.take) ?? null);
  if (chosen.take !== null && take === null) outside.push('take');
  return { autonomy, newWork, autoMerge, take, outside };
}

/** How loose an autonomy level is: Supervised the least, Lights-out the most. */
const looseness = (autonomy: Autonomy) => AUTONOMY.indexOf(autonomy);

/** How much a take lets the line take: just one the least, every ticket the most. */
const breadth = (take: Take) => ({ 'just-one': 0, 'next-few': 1, every: 2 })[take.kind];

/**
 * Which action a change is. A looser autonomy level, auto-merge turned on, and a wider take loosen, and need the
 * passkey again; their opposites tighten, and turning agents' new work off or on asks for nothing (starting the line
 * again is what asks). A take is wider when it takes more kinds of work (every ticket, then the next few, then just
 * one) or, the next few still, a larger number. Just one moved from one work item to another is no wider. A first take,
 * set over the line's own default, which policy cannot see (`LINE_TAKE` may be spent, or `LINE_ONLY` set), counts as
 * wider whatever it is.
 */
export function controlAction(change: ControlChange): ControlAction {
  switch (change.control) {
    case 'autonomy':
      return looseness(change.after) > looseness(change.before) ? 'autonomy.loosen' : 'autonomy.tighten';
    case 'new-work':
      return change.after ? 'new-work.on' : 'new-work.off';
    case 'auto-merge':
      return change.after ? 'auto-merge.on' : 'auto-merge.off';
    case 'take': {
      const { before, after } = change;
      if (before === null) return 'take.widen';
      if (breadth(after) !== breadth(before)) return breadth(after) > breadth(before) ? 'take.widen' : 'take.narrow';
      return after.kind === 'next-few' && before.kind === 'next-few' && after.count > before.count
        ? 'take.widen'
        : 'take.narrow';
    }
  }
}
