/**
 * Running one step of one work item in a runner, and taking its handback.
 *
 *     token → volume → prepare Job → agent Job → handback (or the job failing, or its deadline) → token ended
 *
 * The job token is made before the agent pod starts and ended when the step is over, however it ends, so the gateway
 * and the handback refuse it from then on. The Jobs are deleted afterwards; the volume stays for the next step.
 *
 * The handback (`POST /v1/handback`) takes a job's result with its token, checked with Zod at the door, and hands it
 * to the step waiting for it. A job hands back once.
 */
import type { IncomingMessage, RequestListener } from 'node:http';
import { endJobToken, issueJobToken, jobForToken } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
import type { Handback, Step } from '../../../runner/src/step.ts';
import { agentJob, jobName, NAMESPACE, prepareJob, volume } from './jobs.ts';
import type { Kube } from './kube.ts';

export const handbackBody = z.strictObject({
  ending: z.enum(['finished', 'max-turns', 'failed']),
  patch: z.string().max(1024 * 1024),
  note: z.string().max(4000),
  turns: z.number().int().nonnegative(),
  session: z.string().max(100).nullable(),
  error: z.string().max(4000).optional(),
});

export interface StepRequest extends Step {
  workItem: string;
  /** Which attempt at this agent's step this is, from 1: it names the job. */
  round: number;
  /** How long the agent may run, in seconds. Preparing has ten minutes of its own. */
  deadlineSeconds: number;
}

export type StepOutcome =
  | { kind: 'handed-back'; job: string; handback: Handback }
  /** The prepare or agent pod failed, or ran out of time, without handing anything back. */
  | { kind: 'failed'; job: string; reason: string };

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
}

const PREPARE_SECONDS = 600;

interface JobStatus {
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
  };
}

export class Runners {
  readonly #o: RunnersOptions;
  readonly #waiting = new Map<string, (handback: Handback) => void>();

  constructor(options: RunnersOptions) {
    this.#o = options;
  }

  async run(request: StepRequest): Promise<StepOutcome> {
    const { sql, kube, log } = this.#o;
    const { workItem, round, deadlineSeconds, ...step } = request;
    const job = jobName(step.agent, workItem, round);
    const names = { job, workItem };
    const jobs = `/apis/batch/v1/namespaces/${NAMESPACE}/jobs`;
    const token = await issueJobToken(sql, { job, workItem, agent: step.agent });
    try {
      await kube.create(`/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`, volume(workItem));
      await kube.create(jobs, prepareJob(names, step, { image: this.#o.image, deadlineSeconds: PREPARE_SECONDS }));
      log.info({ job, workItem, agent: step.agent }, 'preparing');
      const prepared = await this.#finished(`${jobs}/${job}-prepare`, PREPARE_SECONDS);
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
        }),
      );
      log.info({ job, workItem, agent: step.agent }, 'the agent is working');
      // The pod ending is checked after the handback could have arrived: a pod hands back, then ends.
      const ended = this.#finished(`${jobs}/${job}-agent`, deadlineSeconds + 60).then(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        return state;
      });
      const first = await Promise.race([
        handedBack.then((handback) => ({ handback })),
        ended.then((state) => ({ state })),
      ]);
      if ('handback' in first) return { kind: 'handed-back', job, handback: first.handback };
      return { kind: 'failed', job, reason: `The agent pod ${first.state} without handing anything back.` };
    } finally {
      this.#waiting.delete(job);
      await endJobToken(sql, job);
      for (const part of ['prepare', 'agent']) {
        await kube
          .remove(`${jobs}/${job}-${part}`)
          .catch((error: Error) => log.warn({ job, err: { message: error.message } }, 'could not delete a job'));
      }
    }
  }

  /** Waits for a Job to end, and says how. */
  async #finished(
    path: string,
    withinSeconds: number,
  ): Promise<'succeeded' | 'failed' | 'ran out of time' | 'vanished'> {
    const until = Date.now() + withinSeconds * 1000;
    while (Date.now() < until) {
      const job = await this.#o.kube.get<JobStatus>(path);
      if (!job) return 'vanished';
      if (job.status?.succeeded) return 'succeeded';
      const failed = job.status?.conditions?.find((c) => c.type === 'Failed' && c.status === 'True');
      if (failed) return failed.reason === 'DeadlineExceeded' ? 'ran out of time' : 'failed';
      await new Promise((resolve) => setTimeout(resolve, this.#o.pollMs ?? 2_000));
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
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new TooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
