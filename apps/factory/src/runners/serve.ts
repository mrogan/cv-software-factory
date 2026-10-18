/**
 * The line's server, as far as runners go: the handback for agent pods on one port, and on another, the steps it
 * runs. The step API has no token: it listens on loopback only, so nothing in the cluster can reach it, and a person
 * reaches it through `kubectl port-forward`, which needs their own rights in the cluster. It takes only JSON, so a web
 * page on the same machine cannot drive it, and bodies of a megabyte at most.
 *
 *     :8081  POST /v1/handback      a job's result, with its token (agent pods)
 *     :8080  POST /v1/steps         run one step (`StepRequest`) and answer with how it went
 *            DELETE /v1/work-items/<id>  the work item merged or is over: delete its volume
 *            GET  /v1/work-items/<id>/logs  what its runners' pods printed, as the line kept them (`logs.ts`)
 *            POST /v1/smoke         the smoke run, from a commit of the app (`smoke.ts`)
 *            GET  /health
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { GitHubWorker } from '../github/worker-client.ts';
import type { StepLogs } from './logs.ts';
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

const MAX_BODY = 1024 * 1024;

async function json(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new RangeError(`The body is over ${MAX_BODY} bytes.`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

export function lineServers({
  runners,
  github,
  log,
  logs,
}: {
  runners: Runners;
  github: GitHubWorker;
  log: Logger;
  /** Where the steps' logs are kept; without it the line keeps none, and serves none. */
  logs?: StepLogs;
}): {
  api: Server;
  handback: Server;
} {
  const send = (res: ServerResponse, status: number, body: unknown) =>
    void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const api = createServer((req, res) => {
    void (async () => {
      const { pathname } = new URL(req.url ?? '/', 'http://line');
      if (pathname === '/health') return send(res, 200, { status: 'ok' });
      const ended = /^\/v1\/work-items\/([1-9]\d{0,8})$/.exec(pathname);
      if (ended?.[1] && req.method === 'DELETE') {
        await runners.finish(ended[1]);
        return send(res, 200, { finished: ended[1] });
      }
      const logged = /^\/v1\/work-items\/([1-9]\d{0,8})\/logs$/.exec(pathname);
      if (logged?.[1] && req.method === 'GET') {
        if (!logs) return send(res, 404, { error: 'The line keeps no logs: ARTIFACTS_DIR is unset.' });
        const workItem = logged[1];
        // Read before the answer starts, so a store that fails answers 500 rather than half a log.
        const found = await logs.of(workItem);
        // Text that is never run: a browser sniffing it as a page would run what an agent printed.
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
        await logs.print(workItem, found, (chunk) => res.write(chunk));
        return void res.end();
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
      if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { error: 'Send the body as application/json.' });
      }
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
      log.error({ err: error }, 'a line request failed');
      if (res.headersSent) return;
      if (error instanceof RangeError || error instanceof SyntaxError)
        send(res, 400, { error: (error as Error).message });
      else send(res, 500, { error: (error as Error)?.message ?? 'failed' });
    });
  });
  return { api, handback: createServer(runners.handback()) };
}
