/**
 * Folding repeated refusals, so a loop shows at once and cannot flood the store. The gateway, and the line as it relays
 * what the GitHub worker and admission control refused, feed each refusal here and append what it gives back.
 *
 * Repeats of one refusal are those of the same mechanism, work item and action. The first is given back at once, to be
 * appended as it is, and opens a minute; the repeats within that minute are held, and once it has passed (`due`) are
 * given back as one refusal, the latest's words, with how many it stands for (`count`) and when the last was
 * (`lastAt`). Then the next repeat is a first again. So one refusal repeated without end is at most two events a minute.
 *
 * Pure: it holds no clock and does no I/O, and is told the time by each refusal and by each `due`. Its caller appends
 * what it gives back, and asks for what is due about once a minute, and for the rest (`drain`) as it stops.
 */
import type { PayloadOf } from '@software-factory/events';

/** How long repeats of one refusal are folded into one: a minute from the first. */
export const FOLD_MS = 60_000;

/** A refusal as a mechanism made it: its own words, once. */
export interface Refusal {
  /** The work item it was refused for, or null for one that is no work item's. */
  workItem: string | null;
  /** When it was refused. */
  at: Date;
  payload: Omit<PayloadOf<'action.refused'>, 'count' | 'lastAt'>;
}

/** A refusal to append: one as it came, or the repeats of one, folded, with how many and when the last was. */
export interface FoldedRefusal {
  workItem: string | null;
  /** When the first of those it stands for was refused: the event's time. */
  at: Date;
  payload: PayloadOf<'action.refused'>;
}

interface Window {
  /** When the first was refused, which opened the minute. */
  opened: number;
  /** The repeats held since, in the order they came. */
  repeats: Refusal[];
}

export class RefusalFolder {
  readonly #ms: number;
  readonly #windows = new Map<string, Window>();

  constructor({ ms = FOLD_MS }: { ms?: number } = {}) {
    this.#ms = ms;
  }

  /**
   * Takes one refusal, and gives back what to append now: the refusal itself if it is the first of its kind in a
   * minute, after the repeats of the minute before it if that minute has passed unasked; nothing if it is a repeat.
   */
  add(refusal: Refusal): FoldedRefusal[] {
    const key = keyOf(refusal);
    const at = refusal.at.getTime();
    const open = this.#windows.get(key);
    if (open && at < open.opened + this.#ms) {
      open.repeats.push(refusal);
      return [];
    }
    const before = open ? this.#close(key, open) : [];
    this.#windows.set(key, { opened: at, repeats: [] });
    return [...before, { workItem: refusal.workItem, at: refusal.at, payload: { ...refusal.payload } }];
  }

  /** The repeats whose minute had passed by `now`, each folded into one refusal, oldest first. */
  due(now: Date): FoldedRefusal[] {
    return [...this.#windows]
      .filter(([, window]) => now.getTime() >= window.opened + this.#ms)
      .flatMap(([key, window]) => this.#close(key, window))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  /** Every repeat held, each kind folded into one refusal, oldest first, whatever the time: for a worker stopping. */
  drain(): FoldedRefusal[] {
    return [...this.#windows]
      .flatMap(([key, window]) => this.#close(key, window))
      .sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  /** How many repeats it holds, not yet given back. */
  get held(): number {
    return [...this.#windows.values()].reduce((sum, window) => sum + window.repeats.length, 0);
  }

  #close(key: string, window: Window): FoldedRefusal[] {
    this.#windows.delete(key);
    const [first] = window.repeats;
    const last = window.repeats.at(-1);
    if (!first || !last) return [];
    const count = window.repeats.length;
    return [
      {
        workItem: last.workItem,
        at: first.at,
        payload: { ...last.payload, ...(count > 1 && { count, lastAt: last.at.toISOString() }) },
      },
    ];
  }
}

/** Repeats of one refusal share its mechanism, work item and action. */
const keyOf = ({ workItem, payload }: Refusal) => JSON.stringify([payload.mechanism, workItem, payload.action]);
