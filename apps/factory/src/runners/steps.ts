/**
 * Running one step of one work item in a runner, and taking its handback.
 *
 *     token → volume → prepare Job → agent Job → handback (or the job failing, or its deadline) → token ended
 *
 * The job token is made before the agent pod starts and ended when the step is over, however it ends, so the gateway
 * and the handback refuse it from then on. The Jobs are deleted afterwards; the volume stays for the next step, until
 * the work item is over (`finish`).
 *
 * The handback (`POST /v1/handback`) takes a job's result with its token, checked with Zod at the door, and hands it
 * to the step waiting for it. A job hands back once.
 *
 * Each attempt at a step has a job of its own, named by its attempt as well as its round: a job's name, and so its
 * token, is used once, and a retry never finds the Jobs of the attempt before it. `cancel` deletes the Jobs of every
 * step in hand, for the line stopping; each of those steps ends `stopped`, and nothing it did counts.
 */
import { lookup } from 'node:dns/promises';
import type { IncomingMessage, RequestListener } from 'node:http';
import { isIP } from 'node:net';
import { endJobToken, issueJobToken, jobForToken } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
// Types only: the factory image holds no runner, so a value from it would fail to load there (`test/image.test.ts`).
import type { Handback, Step } from '../../../runner/src/step.ts';
import { agentJob, jobName, NAMESPACE, prepareJob, volume } from './jobs.ts';
import type { Kube } from './kube.ts';

/** The most a result may be, as JSON: the runner's own bound (`apps/runner/src/step.ts`), which a test holds equal. */
export const RESULT_BYTES = 64 * 1024;

export const handbackBody = z.strictObject({
  ending: z.enum(['finished', 'max-turns', 'failed']),
  patch: z.string().max(1024 * 1024),
  note: z.string().max(4000),
  turns: z.number().int().nonnegative(),
  session: z.string().max(100).nullable(),
  error: z.string().max(4000).optional(),
  /** Read through the agent's own schema by the line; here only its size is judged. */
  result: z
    .json()
    .optional()
    .refine(
      (result) => Buffer.byteLength(JSON.stringify(result ?? null)) <= RESULT_BYTES,
      `a result is at most ${RESULT_BYTES} bytes`,
    ),
});

export interface StepRequest extends Step {
  workItem: string;
  /** Which round of this agent's work this is, from 1: a coder sent back by review works a second round. */
  round: number;
  /** Which attempt at the step this is, from 1, unique within the work item: with the round, it names the job. */
  attempt?: number;
  /** How long the agent may run, in seconds. Preparing has ten minutes of its own. */
  deadlineSeconds: number;
}

export type StepOutcome =
  | { kind: 'handed-back'; job: string; handback: Handback }
  /** The prepare or agent pod failed, or ran out of time, without handing anything back. */
  | { kind: 'failed'; job: string; reason: string }
  /** The line stopped while the step ran: its Jobs were deleted, and nothing it did counts. */
  | { kind: 'stopped'; job: string };

export interface RunnersOptions {
  sql: Sql;
  kube: Kube;
  /** The `factory-runner` image, by digest. */
  image: string;
  /** How an agent pod reaches the gateway, and the handback. */
  gatewayUrl: string;
  handbackUrl: string;
  log: Logger;
  /** How often a Job's state is read. */
  pollMs?: number;
  /** How long a handback may follow the agent pod's end: a pod hands back, then ends. */
  graceMs?: number;
  /** Injected so tests need neither real waiting nor a real clock, nor real names. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  lookup?: (hostname: string) => Promise<string>;
}

const PREPARE_SECONDS = 600;

const JOB = z.object({
  status: z
    .object({
      succeeded: z.number().optional(),
      conditions: z.array(z.object({ type: z.string(), status: z.string(), reason: z.string().optional() })).optional(),
    })
    .optional(),
});

export class Runners {
  readonly #o: RunnersOptions;
  readonly #waiting = new Map<string, (handback: Handback) => void>();
  /** The jobs of the steps in hand, and those of them the line has stopped. */
  readonly #running = new Set<string>();
  readonly #stopped = new Set<string>();

  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(options: RunnersOptions) {
    this.#o = options;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? Date.now;
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    const { sql, kube, log } = this.#o;
    const { workItem, round, attempt = 1, deadlineSeconds, ...step } = request;
    const job = jobName(step.agent, workItem, round, attempt);
    const names = { job, workItem };
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    const token = await issueJobToken(sql, { job, workItem, agent: step.agent });
    this.#running.add(job);
    try {
      await kube.create(`/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`, volume(workItem));
      await kube.create(jobs, prepareJob(names, step, { image: this.#o.image, deadlineSeconds: PREPARE_SECONDS }));
      log.info({ job, workItem, agent: step.agent }, 'preparing');
      const prepared = await this.#finished(`${jobs}/${job}-prepare`, PREPARE_SECONDS);
      if (this.#stopped.has(job)) return { kind: 'stopped', job };
      if (prepared !== 'succeeded') return { kind: 'failed', job, reason: `The prepare pod ${prepared}.` };

      const handedBack = new Promise<Handback>((resolve) => this.#waiting.set(job, resolve));
      await kube.create(
        jobs,
        agentJob(names, step, {
          image: this.#o.image,
          deadlineSeconds,
          gatewayUrl: this.#o.gatewayUrl,
          handbackUrl: this.#o.handbackUrl,
          token,
          hosts: await this.#hosts(),
        }),
      );
      log.info({ job, workItem, agent: step.agent }, 'the agent is working');
      // The pod ending is checked after the handback could have arrived: a pod hands back, then ends.
      const ended = this.#finished(`${jobs}/${job}-agent`, deadlineSeconds + 60).then(async (state) => {
        await this.#sleep(this.#o.graceMs ?? 2_000);
        return state;
      });
      const first = await Promise.race([
        handedBack.then((handback) => ({ handback })),
        ended.then((state) => ({ state })),
      ]);
      if (this.#stopped.has(job)) return { kind: 'stopped', job };
      if ('handback' in first) return { kind: 'handed-back', job, handback: first.handback };
      return { kind: 'failed', job, reason: `The agent pod ${first.state} without handing anything back.` };
    } finally {
      this.#waiting.delete(job);
      this.#running.delete(job);
      this.#stopped.delete(job);
      // Each of these is tried whatever the others do: a token that will not end must not leave a Job running.
      await endJobToken(sql, job).catch((error: Error) =>
        log.error({ job, err: { message: error.message } }, 'could not end a job token'),
      );
      for (const part of ['prepare', 'agent']) {
        await kube
          .remove(`${jobs}/${job}-${part}`)
          .catch((error: Error) => log.warn({ job, err: { message: error.message } }, 'could not delete a job'));
      }
    }
  }

  /**
   * The line has stopped: deletes the Jobs of every step in hand, so no agent works on. Each of those steps ends
   * `stopped` within a poll, and ends its token as any step does.
   */
  async cancel(): Promise<void> {
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    for (const job of this.#running) {
      this.#stopped.add(job);
      for (const part of ['prepare', 'agent']) {
        await this.#o.kube
          .remove(`${jobs}/${job}-${part}`)
          .catch((error: Error) =>
            this.#o.log.warn({ job, err: { message: error.message } }, 'could not delete a job'),
          );
      }
      this.#o.log.info({ job }, 'the line stopped; the step’s jobs are deleted');
    }
  }

  /** The work item is over: its volume goes. */
  async finish(workItem: string): Promise<void> {
    const path = `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims/${volume(workItem).metadata.name}`;
    await this.#o.kube.remove(path);
    this.#o.log.info({ workItem }, 'the work item is over; its volume is deleted');
  }

  /** The addresses an agent pod needs, looked up here because it has no DNS of its own. */
  async #hosts(): Promise<{ ip: string; hostnames: string[] }[]> {
    const find = this.#o.lookup ?? (async (hostname: string) => (await lookup(hostname)).address);
    const names = [...new Set([this.#o.gatewayUrl, this.#o.handbackUrl].map((url) => new URL(url).hostname))];
    const hosts = await Promise.all(
      names.filter((name) => !isIP(name)).map(async (name) => ({ ip: await find(name), hostnames: [name] })),
    );
    return hosts;
  }

  /** Waits for a Job to end, and says how. */
  async #finished(
    path: string,
    withinSeconds: number,
  ): Promise<'succeeded' | 'failed' | 'ran out of time' | 'vanished'> {
    const until = this.#now() + withinSeconds * 1000;
    while (this.#now() < until) {
      const job = await this.#o.kube.get(path, JOB);
      if (!job) return 'vanished';
      if (job.status?.succeeded) return 'succeeded';
      const failed = job.status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
      if (failed) return failed.reason === 'DeadlineExceeded' ? 'ran out of time' : 'failed';
      await this.#sleep(this.#o.pollMs ?? 2_000);
    }
    return 'ran out of time';
  }

  /** `POST /v1/handback`, for agent pods. */
  handback(): RequestListener {
    const send = (res: Parameters<RequestListener>[1], status: number, body: unknown): void =>
      void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    return async (req, res) => {
      const { pathname } = new URL(req.url ?? '/', 'http://line');
      if (pathname === '/health') return send(res, 200, { status: 'ok' });
      if (pathname !== '/v1/handback' || req.method !== 'POST') return send(res, 404, { error: 'not found' });
      try {
        const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
        const job = token ? await jobForToken(this.#o.sql, token) : undefined;
        if (!job) return send(res, 401, { error: 'This is not the token of a job that is running.' });
        const parsed = handbackBody.safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) {
          return send(res, 400, {
            error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        }
        const waiting = this.#waiting.get(job.job);
        if (!waiting) return send(res, 409, { error: 'Nothing is waiting for this job to hand back.' });
        this.#waiting.delete(job.job);
        waiting(parsed.data as Handback);
        this.#o.log.info({ job: job.job, ending: parsed.data.ending, patch: parsed.data.patch.length }, 'handed back');
        send(res, 202, { taken: true });
      } catch (error) {
        if (error instanceof TooLarge) return send(res, 413, { error: `The body is over ${MAX_BODY} bytes.` });
        if (error instanceof SyntaxError) return send(res, 400, { error: 'The body is not JSON.' });
        this.#o.log.error({ err: { message: (error as Error)?.message } }, 'the handback failed');
        send(res, 500, { error: 'The handback failed.' });
      }
    };
  }
}

const MAX_BODY = 2 * 1024 * 1024;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Read to the end even when it is too big, keeping none of it, so the refusal can be sent.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  if (size > MAX_BODY) throw new TooLarge();
  return Buffer.concat(chunks).toString('utf-8');
}
