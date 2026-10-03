/**
 * The intake: an HTTP server for Alertmanager's webhook (`POST /v1/alerts`). Each firing alert becomes one signal in
 * the inbox; a resolved alert writes nothing.
 *
 * Alertmanager sends again after a 5xx and never after a 4xx, so an alert the factory cannot use is answered 422 and
 * one that failed for a reason that may pass (a backend down, the database) is answered 503.
 */
import type { IncomingMessage, RequestListener } from 'node:http';
import type { Logger } from 'pino';
import type { Outbox } from '../outbox.ts';
import { type Backends, parse, Refused, signalFor } from './alerts.ts';

const MAX_BODY_BYTES = 1_000_000;

export interface Intake {
  backends: Backends;
  outbox: Outbox;
  log: Logger;
}

export function createIntake({ backends, outbox, log }: Intake): RequestListener {
  return async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    const { pathname } = new URL(req.url ?? '/', 'http://intake');
    if (pathname === '/health') return send(200, { ok: true });
    if (pathname !== '/v1/alerts' || req.method !== 'POST') return send(404, { error: 'not found' });

    let alerts: ReturnType<typeof parse>;
    try {
      alerts = parse(JSON.parse(await readBody(req)));
    } catch {
      return send(400, { error: 'the body is not an Alertmanager webhook' });
    }

    let accepted = 0;
    let refused = 0;
    let failed = 0;
    for (const alert of alerts.filter((a) => a.status === 'firing')) {
      const route = alert.labels.route;
      try {
        await outbox.send(await signalFor(alert, backends));
        accepted += 1;
        log.info({ route, objective: alert.labels.objective }, 'alert became a signal');
      } catch (error) {
        if (error instanceof Refused) {
          refused += 1;
          log.warn({ route, objective: alert.labels.objective, reason: error.message }, 'alert refused');
        } else {
          failed += 1;
          log.error(
            { route, objective: alert.labels.objective, err: error },
            'alert failed; Alertmanager will send it again',
          );
        }
      }
    }
    send(failed ? 503 : refused && !accepted ? 422 : 200, { accepted, refused, failed });
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('The body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
