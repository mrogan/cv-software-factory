/**
 * The gateway over HTTP, for the workers in the cluster.
 *
 *     POST /v1/judgements   a judgement request as JSON (`JudgeRequest`); the answers, cost and cassette key out
 *     GET  /v1/spend        today's and this month's spend against the caps
 *     GET  /health          for the cluster's probes
 *
 * Errors keep their meaning: a spend cap is 429 with the cap and when it resets (and `Retry-After`), a request
 * with no cassette in replay is 409, a provider that failed is 502, a request the gateway will not send is 400
 * (413 when it is too big). No error body echoes the request, which may hold a report's text.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Gateway } from './gateway.ts';
import type { Logger } from './log.ts';
import type { Spend } from './spend.ts';
import { errorResponse } from './wire.ts';

/** A judgement request is a few hundred tokens of text; this leaves room for a long report and its context. */
const MAX_BODY_BYTES = 256 * 1024;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Reads to the end even when it is too big, and keeps none of it: stopping early would drop the connection
  // before the 413 could be sent.
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new TooLarge();
  return Buffer.concat(chunks).toString('utf-8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

export interface ServerOptions {
  gateway: Gateway;
  spend: Spend;
  log: Logger;
  clock?: () => Date;
}

export function createGatewayServer({ gateway, spend, log, clock = () => new Date() }: ServerOptions): Server {
  async function judgements(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let input: unknown;
    try {
      input = JSON.parse(await readBody(req));
    } catch (error) {
      if (error instanceof TooLarge) {
        return send(res, 413, { error: 'bad-request', message: `The request is over ${MAX_BODY_BYTES} bytes.` });
      }
      return send(res, 400, { error: 'bad-request', message: 'The request is not valid JSON.' });
    }
    // The gateway checks the request; this only hands it over.
    send(res, 200, await gateway.judge(input as Parameters<Gateway['judge']>[0]));
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://gateway');
    const only = (method: string) => {
      if (req.method === method) return true;
      send(res, 405, { error: 'bad-request', message: `Use ${method}.` }, { allow: method });
      return false;
    };
    if (pathname === '/health') {
      if (only('GET')) send(res, 200, { status: 'ok', mode: gateway.mode });
    } else if (pathname === '/v1/spend') {
      if (only('GET')) send(res, 200, await spend.report());
    } else if (pathname === '/v1/judgements') {
      if (only('POST')) await judgements(req, res);
    } else {
      send(res, 404, { error: 'bad-request', message: 'There is nothing here.' });
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const { status, body, retryAfterSeconds } = errorResponse(error, clock().getTime());
      if (status === 500) {
        // The type and message only: an error's other fields can hold a query's parameters.
        log.error({ err: { type: (error as Error)?.name, message: (error as Error)?.message } }, 'request failed');
      }
      if (res.headersSent) return void res.destroy();
      send(res, status, body, retryAfterSeconds ? { 'retry-after': String(retryAfterSeconds) } : {});
    });
  });
}
