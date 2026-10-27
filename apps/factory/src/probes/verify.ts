/**
 * A ticket's check run again, for Verify: the line asks, and the probes worker, which has the browser the line's image
 * lacks, runs the probe or the crawl that made the check against the stable Service, as often as it takes to say.
 *
 * It is served on a port of its own (`verifyServer`, VERIFY_PORT): the line may reach it, and not the page reader beside
 * it, which would show it any page of the app. A feature flag's check, Verify by variant's, is served beside it
 * (`POST /v1/flag-check`, `probes/flag-check.ts`), asked and polled the same way, and run in turn with it.
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
import { type FlagCheckAnswer, type FlagCheckRequest, flagCheckRequest } from './flag-check.ts';

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

/** Where a verification, or any run asked and polled as one is, stands: running, or done with its answer. */
export type JobStatus<A> = { state: 'running' } | { state: 'done'; answer: A };
export type VerifyStatus = JobStatus<VerifyAnswer>;

/**
 * Runs in hand, by what they are known by (`key`). An answer waits `keepMs` to be collected, and one that failed is
 * thrown to the next to ask; either way it is then forgotten, and asking again starts afresh.
 */
export class Jobs<R, A> {
  readonly #run: (request: R) => Promise<A>;
  readonly #key: (request: R) => string;
  readonly #keepMs: number;
  readonly #now: () => number;
  readonly #jobs = new Map<string, { answer?: A; error?: unknown; doneAt?: number }>();

  constructor(run: (request: R) => Promise<A>, key: (request: R) => string, keepMs = 30 * 60_000, now = Date.now) {
    this.#run = run;
    this.#key = key;
    this.#keepMs = keepMs;
    this.#now = now;
  }

  ask(request: R): JobStatus<A> {
    for (const [key, job] of this.#jobs) {
      if (job.doneAt !== undefined && this.#now() - job.doneAt > this.#keepMs) this.#jobs.delete(key);
    }
    const key = this.#key(request);
    const job = this.#jobs.get(key);
    if (!job) {
      const started: { answer?: A; error?: unknown; doneAt?: number } = {};
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

/** The verifications in hand, by sense and check, one running at a time. */
export class Verifications extends Jobs<VerifyRequest, VerifyAnswer> {
  constructor(run: (request: VerifyRequest) => Promise<VerifyAnswer>, keepMs = 30 * 60_000, now = Date.now) {
    super(oneAtATime(run), (request) => `${request.sense} ${request.check}`, keepMs, now);
  }
}

/** Serialises verifications: each runs a browser, and the worker runs its own probes beside them. */
export function oneAtATime<A, T>(run: (arg: A) => Promise<T>): (arg: A) => Promise<T> {
  const turn = takingTurns();
  return (arg) => turn(() => run(arg));
}

/** Runs each piece of work it is given after the one before has ended, however that one ended. */
export function takingTurns(): <T>(work: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  return (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
}

/** The most a request may be: a flag's check names its baseline's checks that did not pass cleanly. */
const MOST_BYTES = { '/v1/verify': 1_000, '/v1/flag-check': 64_000 } as const;

/**
 * The verification's own server: `POST /v1/verify`, `POST /v1/flag-check` (`probes/flag-check.ts`) and `GET /health`,
 * and nothing else. Without `flagCheck`, a flag's check is not found.
 */
export function verifyServer({
  verify,
  flagCheck,
  log,
}: {
  verify: (request: VerifyRequest) => VerifyStatus | Promise<VerifyStatus>;
  flagCheck?: (request: FlagCheckRequest) => JobStatus<FlagCheckAnswer> | Promise<JobStatus<FlagCheckAnswer>>;
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}): Server {
  return createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && req.url === '/health') return reply(200, { status: 'ok' });
      const url = req.url;
      if (req.method !== 'POST' || (url !== '/v1/verify' && (url !== '/v1/flag-check' || !flagCheck))) {
        return reply(404, { error: 'not found' });
      }
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > MOST_BYTES[url]) return reply(413, { error: 'too large' });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return reply(400, { error: 'the body is not JSON' });
      }
      if (url === '/v1/flag-check' && flagCheck) {
        const asked = flagCheckRequest.safeParse(body);
        if (!asked.success) return reply(400, { error: "a flag's check names a flag, its stage and the revision" });
        const status = await flagCheck(asked.data);
        if (status.state === 'running') return reply(202, { state: 'running' });
        const { flag, stage } = asked.data;
        log.info({ flag, stage, answer: status.answer.kind }, "a flag's check ran");
        return reply(200, status.answer);
      }
      const asked = verifyRequest.safeParse(body);
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
