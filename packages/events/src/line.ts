/**
 * What the line decides by and the console draws with: the bounds on a work item's loop, how a spec's scope matches a
 * path, and a return's few words. One copy, here, because the console's image holds the events package and not the
 * factory's code, and two copies of a rule drift apart. Plain values, so the browser can import them.
 */
import type { Stage } from './vocabulary.ts';

/** How far the line lets a work item go round before it holds for Martin. */
export const LIMITS = {
  /** Reviews a work item has: blocking findings after the last of them hold it (the decisions: two rounds). */
  reviews: 2,
  /** Times failing gates send the coder back before the work item holds. */
  gateReturns: 2,
  /** Failed attempts at one step (no handback, no result, a result its schema refuses) before it holds. */
  failures: 2,
  /** Tries at a handback's effects, when GitHub or the store fails, before the work item holds. */
  effects: 6,
  /**
   * Patches the scope fence refuses before the work item holds: the first goes back to the coder with the fence's
   * output, and the second holds. Martin's answer to the hold starts the count again.
   */
  fenceRefusals: 2,
} as const;

/**
 * A scope entry as a pattern: a file (`src/money.ts`), a folder ending in `/` (`test/`), or a pattern with `*` (one
 * path segment) or `**` (any number).
 */
export const pattern = (entry: string) =>
  new RegExp(
    `^${entry
      .split(/(\*\*\/?|\*)/)
      .map((part) =>
        part.startsWith('**') ? '.*' : part === '*' ? '[^/]*' : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
      )
      .join('')}${entry.endsWith('/') ? '.*' : ''}$`,
  );

/** Whether any entry of a scope matches a path: the scope fence's rule, and the GitHub worker's. */
export const inScope = (path: string, scope: readonly string[]) => scope.some((entry) => pattern(entry).test(path));

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why work went back to Build, in a few words, from what its `work.returned` records: "2 blocking", "1 check failed".
 * The line writes them in the event's summary and the console draws them, so both say the same.
 */
export function returnWords(returned: {
  from: Stage;
  blocking?: number | undefined;
  failed?: readonly string[] | undefined;
}): string {
  if (returned.blocking !== undefined) return `${returned.blocking} blocking`;
  // The gates hold a run with no failed check named as failed all the same: one check, unnamed.
  if (returned.failed !== undefined) return `${count(returned.failed.length || 1, 'check')} failed`;
  return `sent back from ${returned.from}`;
}
