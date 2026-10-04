/**
 * The line's server, as far as runners go: the handback for agent pods on one port, and on another, which nothing
 * in the cluster may reach (only a person's `kubectl port-forward`), the steps it runs.
 *
 *     :8081  POST /v1/handback      a job's result, with its token (agent pods)
 *     :8080  POST /v1/steps         run one step (`StepRequest`) and answer with how it went
 *            POST /v1/smoke         the smoke run, from a commit of the app (`smoke.ts`)
 *            GET  /health
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { GitHubWorker } from '../github/worker-client.ts';
import { smoke } from './smoke.ts';
import type { Runners, StepRequest } from './steps.ts';

const sha = z.string().regex(/^[0-9a-f]{40}$/);

export const stepRequest = z.strictObject({
  workItem: z.string().regex(/^[1-9]\d{0,8}$/),
  round: z.number().int().positive().max(20),
  agent: z.enum(['planner', 'coder', 'reviewer', 'describer']),
  repository: z.url().startsWith('https://github.com/'),
  commit: sha,
  prompt: z.string().min(1).max(200_000),
  skill: z.string().max(100).optional(),
  maxTurns: z.number().int().positive().max(200),
  resume: z.string().max(100).optional(),
  deadlineSeconds: z
    .number()
    .int()
    .positive()
    .max(4 * 3600),
});

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

export function lineServers({ runners, github, log }: { runners: Runners; github: GitHubWorker; log: Logger }): {
  api: Server;
  handback: Server;
} {
  const send = (res: ServerResponse, status: number, body: unknown) =>
    void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const api = createServer((req, res) => {
    void (async () => {
      const { pathname } = new URL(req.url ?? '/', 'http://line');
      if (pathname === '/health') return send(res, 200, { status: 'ok' });
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      if (pathname === '/v1/steps') {
        const parsed = stepRequest.safeParse(await json(req));
        if (!parsed.success)
          return send(res, 400, {
            error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          });
        return send(res, 200, await runners.run(parsed.data as StepRequest));
      }
      if (pathname === '/v1/smoke') {
        const parsed = z
          .strictObject({ commit: sha, round: z.number().int().positive().optional() })
          .safeParse(await json(req));
        if (!parsed.success) return send(res, 400, { error: 'Give the commit of the app to start from.' });
        return send(
          res,
          200,
          await smoke({ runners, github, commit: parsed.data.commit, round: parsed.data.round ?? 1, log }),
        );
      }
      send(res, 404, { error: 'not found' });
    })().catch((error: unknown) => {
      log.error({ err: { message: (error as Error)?.message } }, 'a line request failed');
      if (!res.headersSent) send(res, 500, { error: (error as Error)?.message ?? 'failed' });
    });
  });
  return { api, handback: createServer(runners.handback()) };
}
