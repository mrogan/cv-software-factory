/**
 * A ticket's check run again, for Verify: the line asks, and the probes worker, which has the browser the line's image
 * lacks, runs the probe or the crawl that made the check against the stable Service, as often as it takes to say.
 *
 *     POST /v1/verify   { "sense": "probe", "check": "departments/console", "route": "/departments/:department" }
 *       ->  { "outcome": "cleared" | "persists" | "unsure", "version": "<commit>", "runs": [...], "evidence"?: <Evidence> }
 *
 * The check is cleared when it passes `inARow` times in a row and persists when it fails as many; a look that runs it
 * `runs` times without either, or once it cannot finish, is unsure, and the line asks again later. A run on a version
 * other than the first's is unsure too: a release came between. Only one verification runs at a time.
 */
import type { Evidence } from '@software-factory/events';
import { z } from 'zod';
import { release } from '../../../../policy/release.ts';
import type { Seen } from '../gates/journeys.ts';

/** What the line asks: the sense and check of the ticket's first signal, and its route. */
export const verifyRequest = z.strictObject({
  sense: z.enum(['probe', 'crawler']),
  check: z.string().min(1).max(80),
  route: z
    .string()
    .regex(/^(\*|\/[^\s]*)$/)
    .max(200),
});
export type VerifyRequest = z.infer<typeof verifyRequest>;

/** What one run of the check saw. */
export type Run = 'passed' | 'failed' | 'unsure';

export interface VerifyAnswer {
  outcome: 'cleared' | 'persists' | 'unsure';
  /** The version the stable Service ran when the check first ran. */
  version: string;
  runs: Run[];
  /** Why the last run failed, or could not tell, in the check's words. */
  message?: string;
  /** What the last failed run kept as proof, when the outcome is that it persists. */
  evidence?: Evidence;
}

/** Runs the senses against the stable Service and says what each check saw, as `senses/observe.ts` does. */
export type ObserveStable = (
  only: readonly Pick<Seen, 'sense' | 'check'>[],
) => Promise<{ version: string; seen: Seen[] }>;

export async function verifyCheck(
  observe: ObserveStable,
  request: VerifyRequest,
  policy: { inARow: number; runs: number } = release.verify.checks,
): Promise<VerifyAnswer> {
  const runs: Run[] = [];
  let version: string | undefined;
  let message: string | undefined;
  let evidence: Evidence | undefined;
  while (runs.length < policy.runs) {
    const looked = await observe([{ sense: request.sense, check: request.check }]);
    version ??= looked.version;
    // A check names itself whatever page it found a problem on: a probe's route moves with what it found, and a
    // crawler's check carries its route in its name.
    const seen = looked.seen.find((s) => s.sense === request.sense && s.check === request.check);
    if (looked.version !== version || !seen || seen.trouble) {
      runs.push('unsure');
      message = looked.version !== version ? `The app moved to ${looked.version}` : (seen?.trouble ?? 'Not seen');
      break;
    }
    runs.push(seen.failed ? 'failed' : 'passed');
    if (seen.failed) {
      message = seen.message;
      evidence = seen.evidence?.[0];
    }
    const last = runs.slice(-policy.inARow);
    if (last.length === policy.inARow && last.every((run) => run === last[0])) {
      return {
        outcome: last[0] === 'passed' ? 'cleared' : 'persists',
        version,
        runs,
        ...(message && last[0] === 'failed' ? { message } : {}),
        ...(evidence && last[0] === 'failed' ? { evidence } : {}),
      };
    }
  }
  return { outcome: 'unsure', version: version ?? 'unknown', runs, ...(message ? { message } : {}) };
}

/** Serialises verifications: each runs a browser, and the worker runs its own probes beside them. */
export function oneAtATime<A, T>(run: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return (arg) => {
    const next = queue.then(() => run(arg));
    queue = next.catch(() => {});
    return next;
  };
}
