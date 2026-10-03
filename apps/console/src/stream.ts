/**
 * Server-sent events: every public event after the one a client last had, then each new one as it is appended.
 *
 * Each event goes out with its seq as its ID. A browser that loses the connection reconnects on its own with
 * `Last-Event-ID`, and gets every event it missed, once. A comment every 15 seconds keeps idle connections open
 * through proxies, and a client too slow to keep up is disconnected, to resume from where it was.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { metrics } from '@opentelemetry/api';
import type { Feed, FeedEvent, StoreKind } from './feed.ts';

const meter = metrics.getMeter('console');
const clients = meter.createUpDownCounter('console.stream.clients', {
  description: 'Browsers connected to the event stream',
});
const sent = meter.createCounter('console.stream.events', { description: 'Events sent to browsers' });
const delay = meter.createHistogram('console.stream.delay', {
  description: 'Time from an event being appended to the store to its being sent to a browser',
  unit: 's',
  advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5] },
});

export interface StreamOptions {
  heartbeatMs?: number;
  /** How much may wait unsent for one client before it is cut off. */
  maxBufferedBytes?: number;
}

/** Where a client resumes: the ID of the last event it had, or `?after=` on its first connection. */
export function resumeFrom(req: IncomingMessage, url: URL): number {
  const value = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0';
  const seq = Number(Array.isArray(value) ? value[0] : value);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : 0;
}

export function stream(
  feed: Feed,
  req: IncomingMessage,
  res: ServerResponse,
  after: number,
  { heartbeatMs = 15_000, maxBufferedBytes = 1 << 20 }: StreamOptions = {},
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tells a buffering proxy (nginx, for one) to pass each event straight on.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  // First, what the store holds: not an event, so it goes as a message of its own kind.
  const tellKind = (kind: StoreKind) => res.write(`event: store\ndata: ${JSON.stringify({ kind })}\n\n`);
  tellKind(feed.kind);
  // And again if the store learns what it holds while the stream is open (an empty store, marked by `make real-store`).
  const unsubscribeKind = feed.onKind(tellKind);
  clients.add(1);

  let last = after;
  const send = (event: FeedEvent, live: boolean) => {
    if (event.seq <= last || res.destroyed) return;
    last = event.seq;
    res.write(`id: ${event.seq}\ndata: ${event.json}\n\n`);
    sent.add(1);
    // Only events sent as they arrive say how long delivery takes; the backlog is as old as it is.
    if (live) delay.record(Math.max(0, Date.now() - event.appendedAt) / 1000);
    if (res.writableLength > maxBufferedBytes) res.destroy();
  };

  // Subscribing and reading the backlog in the same tick leaves no gap for an event to fall into.
  const unsubscribe = feed.subscribe((event) => send(event, true));
  for (const event of feed.after(after)) send(event, false);

  const heartbeat = setInterval(() => res.write(': still here\n\n'), heartbeatMs);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    unsubscribeKind();
    clients.add(-1);
  };
  res.once('close', close);
  req.once('aborted', () => res.destroy());
}
