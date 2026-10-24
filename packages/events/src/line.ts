/**
 * What the line decides by and the console draws with: the bounds on a work item's loop, what each answer to a hold
 * does, how a spec's scope matches a path and another spec's scope, when two versions are the same, and a return's few
 * words. One copy, here, because the console's image holds the events package and not the factory's code, and two
 * copies of a rule drift apart. Plain values, so the browser can import them.
 */
import type { HoldAnswer, HoldCause, Stage } from './vocabulary.ts';

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
  /**
   * Verifications after a release that find the ticket's signal persisting before the work item holds: the first
   * sends the work back to Plan, with the verification, and the second holds for Martin.
   */
  persists: 2,
  /**
   * Rounds the suggestions of an approving review send the coder back for, in a pass, to take or decline them before
   * the reviewer looks again. The review after that round goes on, whatever it suggests.
   */
  suggestions: 1,
} as const;

/**
 * Triage's causes of a hold, which an answer in words leaves standing: triage acts only on Martin's approval or
 * rejection of what they hold, so his words settle nothing, and the work item stays held, and Needs you lists it,
 * until he gives one. The line's `ANSWERS` has each wait for an answer in words.
 */
export const WORDS_LEAVE_HELD: readonly HoldCause[] = ['suggestion', 'finding', 'burst', 'environment'];

/** What Martin's answer to a hold does to the work item. */
export type Resolution =
  /** It carries on from where it was held: the step it was held at runs again, with his answer. */
  | 'carry-on'
  /** The planner writes the spec again, with his answer. */
  | 'replan'
  /** His approval stands in for the reviewer's, and the change goes on to its description and his merge. */
  | 'approve'
  /** The work goes back to the coder, with his answer as the reason. */
  | 'return'
  /** Nothing for the line to do: it waits for him, as for his merge. */
  | 'wait'
  /** He judges the fix verified in production, and the work item closes as verified. */
  | 'verified'
  /** The work item closes unmerged. */
  | 'close';

/**
 * What each answer does, for each cause of a hold: the line acts by it, and Needs you says it beside each answer.
 * Rejecting closes the work item, whatever the cause. Where the planner rejected the ticket, approving agrees with it
 * and closes the work item too; only an answer, which tells the planner what it missed, sends the ticket back to it.
 * Where the fence kept refusing the coder's patch, approving says the coder needed those files and answering says what
 * to do instead: either way the planner writes the spec again, told both. Where the coder's first round found nothing
 * to fix, approving agrees with it and closes the work item; answering sends the spec back to the planner, told what
 * the coder said and what Martin did.
 */
export const ANSWERS: Record<HoldCause, Record<HoldAnswer, Resolution>> = {
  // Triage's: a suggestion never comes onto the line, nor does a defect only the planner has seen until Martin approves
  // it, nor a burst's problems, or those seen while what their sense reads was not healthy, until he lets them through.
  // Triage then opens their tickets, and the line carries each on from there as any other. Triage closes a suggestion
  // he rejects; approving one means nothing yet (Part B makes it an improvement).
  suggestion: { approved: 'wait', rejected: 'close', answered: 'wait' },
  finding: { approved: 'carry-on', rejected: 'close', answered: 'wait' },
  burst: { approved: 'carry-on', rejected: 'close', answered: 'wait' },
  environment: { approved: 'carry-on', rejected: 'close', answered: 'wait' },
  spec: { approved: 'carry-on', rejected: 'close', answered: 'replan' },
  question: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  'ticket-rejected': { approved: 'close', rejected: 'close', answered: 'carry-on' },
  scope: { approved: 'replan', rejected: 'close', answered: 'replan' },
  'nothing-to-fix': { approved: 'close', rejected: 'close', answered: 'replan' },
  failures: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  gates: { approved: 'return', rejected: 'close', answered: 'return' },
  review: { approved: 'approve', rejected: 'close', answered: 'return' },
  'beyond-ticket': { approved: 'approve', rejected: 'close', answered: 'replan' },
  // Martin merges on GitHub, which answers the hold; his words send the work back to the coder.
  merge: { approved: 'wait', rejected: 'close', answered: 'return' },
  // A deploy is merged by Martin, not answered: a release that carries the change ends the hold by itself.
  deploy: { approved: 'wait', rejected: 'close', answered: 'wait' },
  // At Verify, when no sense can tell or the signal persisted again: approving says the fix is verified, and answering
  // sends the work back to the planner with what he said.
  verify: { approved: 'verified', rejected: 'close', answered: 'replan' },
  // The cap is Martin's, within policy: approving carries on, and the line holds again until the cap is raised. Raising
  // the work item's cap past what it has spent approves it (the admin service, `admin/settings.ts`).
  spend: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  // The line makes no such hold yet: approving accepts the tests as they are, answering says what to test.
  'tests-first': { approved: 'carry-on', rejected: 'close', answered: 'return' },
  unknown: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
};

/**
 * The answers a hold of this cause takes from the console, in the order Needs you shows them: each that does
 * something. An answer the line would only wait after is left off (a fix waiting for Martin's deploy takes only his
 * rejection), but for words on one of triage's holds, which are kept with it while it stays held.
 */
export const answersTo = (cause: HoldCause): HoldAnswer[] =>
  (['approved', 'answered', 'rejected'] as const).filter(
    (answer) => ANSWERS[cause][answer] !== 'wait' || (answer === 'answered' && WORDS_LEAVE_HELD.includes(cause)),
  );

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

/**
 * Whether a scope entry takes in any of the paths, which may be folders or patterns too: names one, is a folder or
 * pattern with one in it, or is a folder's name without its slash. A folder stands for a file in it, and a pattern
 * that matches anywhere (one under any folder) for its name at the top. The planner keeps its scope out of the protected
 * paths by it, and the line tells two specs that share a file by it.
 */
export function touches(entry: string, paths: readonly string[]): boolean {
  if (inScope(entry, paths)) return true;
  const within = pattern(entry);
  return paths.some((path) => {
    const sample = path.replace(/^\*\*\//, '').replace(/\*/g, 'x');
    return sample.endsWith('/') ? within.test(`${sample}x`) || within.test(sample.slice(0, -1)) : within.test(sample);
  });
}

/** The entries of one scope that share a file with another's: in either direction, as `touches` reads them. */
export const scopesOverlap = (a: readonly string[], b: readonly string[]): string[] =>
  a.filter((entry) => b.some((other) => touches(entry, [other]) || touches(other, [entry])));

/** Work items in words: "work item #1033", "work items #1033 and #1040", or `none` for none. */
export function workItemsWords(items: readonly string[], none: string): string {
  const named = items.map((n) => `#${n}`);
  if (!named.length) return none;
  const listed = named.length > 1 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named[0];
  return `work item${named.length > 1 ? 's' : ''} ${listed}`;
}

/**
 * The release a look again found a held or waiting work item's signal cleared on, in words: what it carried, and that
 * it was not this one's fix. The line's comments and closes, and the console, say it the same way.
 */
export const clearedOnWords = (carried: readonly string[]) =>
  carried.length
    ? `a release that carried ${workItemsWords(carried, '')}, not this one’s fix`
    : 'a release that carried none of the factory’s fixes';

/** The same version of the app, whether either names its commit in full or shortened. */
export const sameVersion = (a: string, b: string) =>
  a === b || (/^[0-9a-f]{7,40}$/.test(a) && /^[0-9a-f]{7,40}$/.test(b) && (a.startsWith(b) || b.startsWith(a)));

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why work went back to Build, in a few words, from what its `work.returned` records: "2 blocking", "1 check failed",
 * "2 suggestions". The line writes them in the event's summary and the console draws them, so both say the same.
 */
export function returnWords(returned: {
  from: Stage;
  blocking?: number | undefined;
  suggestions?: number | undefined;
  failed?: readonly string[] | undefined;
}): string {
  if (returned.blocking !== undefined) return `${returned.blocking} blocking`;
  if (returned.suggestions !== undefined) return count(returned.suggestions, 'suggestion');
  // The gates hold a run with no failed check named as failed all the same: one check, unnamed.
  if (returned.failed !== undefined) return `${count(returned.failed.length || 1, 'check')} failed`;
  return `sent back from ${returned.from}`;
}
