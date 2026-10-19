/**
 * A ticket's check run again, for Verify: the line asks, and the probes worker, which has the browser the line's image
 * lacks, runs the probe or the crawl that made the check against the stable Service, as often as it takes to say.
 *
 * It is served on a port of its own (`verifyServer`, VERIFY_PORT): the line may reach it, and not the page reader beside
 * it, which would show it any page of the app.
 *
 *     POST /v1/verify   { "sense": "probe", "check": "departments/console", "route": "/departments/:department" }
 *       ->  202 while it runs; then 200 { "outcome": "cleared" | "persists" | "unsure", "version": "<commit>",
 *                                           "runs": [...], "evidence"?: <Evidence> }
 *
 * The check is cleared when it passes `inARow` times in a row and persists when it fails as many; a look that runs it
 * `runs` times without either, or once it cannot finish, is unsure, and the line asks again later. A run on a version
 * other than the first's is unsure too: a release came between.
 *
 * A crawl run four times takes longer than an HTTP client waits for an answer, so asking starts the verification and
 * answers at once that it runs; asking again for the same check gives the answer once there is one, and forgets it
 * (`Verifications`). Only one verification runs at a time, and asking again joins the one running for that check.
 */
import { createServer, type Server } from 'node:http';
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
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
) => Promise<{ version: string; seen: Seen[]; after: string | null }>;

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
    const moved = looked.version !== version ? looked.version : looked.after !== looked.version ? looked.after : null;
    if (moved !== null || looked.after === null || !seen || seen.trouble) {
      runs.push('unsure');
      message =
        moved !== null
          ? `The app moved to ${moved}`
          : looked.after === null
            ? 'The app did not say its version after the run'
            : (seen?.trouble ?? 'Not seen');
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

/** Where a verification is: running, or done with its answer. */
export type VerifyStatus = { state: 'running' } | { state: 'done'; answer: VerifyAnswer };

/**
 * The verifications in hand, by sense and check, one running at a time. An answer waits `keepMs` to be collected, and
 * one that failed is thrown to the next to ask; either way it is then forgotten, and asking again starts afresh.
 */
export class Verifications {
  readonly #run: (request: VerifyRequest) => Promise<VerifyAnswer>;
  readonly #keepMs: number;
  readonly #now: () => number;
  readonly #jobs = new Map<string, { answer?: VerifyAnswer; error?: unknown; doneAt?: number }>();

  constructor(run: (request: VerifyRequest) => Promise<VerifyAnswer>, keepMs = 30 * 60_000, now = Date.now) {
    this.#run = oneAtATime(run);
    this.#keepMs = keepMs;
    this.#now = now;
  }

  ask(request: VerifyRequest): VerifyStatus {
    for (const [key, job] of this.#jobs) {
      if (job.doneAt !== undefined && this.#now() - job.doneAt > this.#keepMs) this.#jobs.delete(key);
    }
    const key = `${request.sense} ${request.check}`;
    const job = this.#jobs.get(key);
    if (!job) {
      const started: { answer?: VerifyAnswer; error?: unknown; doneAt?: number } = {};
      this.#jobs.set(key, started);
      // Outside the request that asked for it, which has answered by then: a rerun is the probes' own round, untraced.
      context
        .with(ROOT_CONTEXT, () => this.#run(request))
        .then(
          (answer) => Object.assign(started, { answer, doneAt: this.#now() }),
          (error: unknown) => Object.assign(started, { error, doneAt: this.#now() }),
        );
      return { state: 'running' };
    }
    if (job.doneAt === undefined) return { state: 'running' };
    this.#jobs.delete(key);
    if (job.answer) return { state: 'done', answer: job.answer };
    throw job.error;
  }
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

/** The verification's own server: `POST /v1/verify` and `GET /health`, and nothing else. */
export function verifyServer({
  verify,
  log,
}: {
  verify: (request: VerifyRequest) => VerifyStatus | Promise<VerifyStatus>;
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}): Server {
  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
      if (req.method !== 'POST' || req.url !== '/v1/verify') return reply(404, { error: 'not found' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000) return reply(413, { error: 'too large' });
      }
      let asked: ReturnType<typeof verifyRequest.safeParse>;
      try {
        asked = verifyRequest.safeParse(JSON.parse(raw));
      } catch {
        return reply(400, { error: 'the body is not JSON' });
      }
      if (!asked.success) return reply(400, { error: 'a verification names a sense, a check and a route' });
      const status = await verify(asked.data);
      if (status.state === 'running') return reply(202, { state: 'running' });
      const { answer } = status;
      log.info({ ...asked.data, outcome: answer.outcome, runs: answer.runs }, 'a check was run again');
      return reply(200, answer);
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.message.split('\n')[0] : String(error) },
        'a check could not be run again',
      );
      return reply(502, { error: 'the check could not be run' });
    }
  });
}
