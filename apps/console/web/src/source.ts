/**
 * Where the console's events come from. The page's `sf-events` meta tag says: "live" reads this server's events
 * and follows them as they arrive; "log:<folder>" reads an event-log folder once, as the replay site does. The
 * projection cannot tell which; this module is the only part that knows.
 */
import { type PublicEvent, parseLog, type RawEvent, upcast } from '@software-factory/events';
import { useEffect, useRef, useState } from 'react';

export type Connection =
  /** Nothing has arrived yet. */
  | 'loading'
  /** Following the store as events are appended. */
  | 'live'
  /** Lost the connection; the browser is trying again, and will get whatever it missed. */
  | 'reconnecting'
  /** A recording: everything there is arrived at once. */
  | 'recorded'
  /** The events could not be read at all. */
  | 'failed';

export interface Source {
  events: PublicEvent[];
  connection: Connection;
  /** Events written by a newer factory than this console, which it leaves out rather than guess at. */
  newer: { type: string; version: number }[];
}

export type Origin = { kind: 'live' } | { kind: 'log'; base: string };

/**
 * With `?debug=events`, every seq as it arrives, duplicates and all, for the test that drops the stream and checks
 * nothing was missed or sent twice.
 */
const received: number[] | undefined = new URLSearchParams(location.search).get('debug') === 'events' ? [] : undefined;
if (received) (globalThis as { sfReceived?: number[] }).sfReceived = received;
const note = (raws: RawEvent[]) => {
  if (received) for (const raw of raws) if (raw.seq !== undefined) received.push(raw.seq);
};

/** Reads the page's meta tag. Anything unexpected means live. */
export function origin(doc: Document = document): Origin {
  const content = doc.querySelector('meta[name="sf-events"]')?.getAttribute('content') ?? 'live';
  if (!content.startsWith('log:')) return { kind: 'live' };
  const base = content.slice('log:'.length);
  return { kind: 'log', base: base.endsWith('/') ? base : `${base}/` };
}

/** Where an artifact is: the server's `/artifacts/`, or the log folder's own. */
export const artifactUrl = (from: Origin, hash: string) =>
  from.kind === 'live' ? `/artifacts/${hash}` : `${from.base}artifacts/${hash}`;

/** Adds events in seq order, upcast, skipping any already held; returns what it could not understand. */
function merge(held: PublicEvent[], incoming: RawEvent[]): { events: PublicEvent[]; newer: Source['newer'] } {
  const last = held.at(-1)?.seq ?? 0;
  const events = [...held];
  const newer: Source['newer'] = [];
  for (const raw of incoming) {
    if (raw.seq !== undefined && raw.seq <= last) continue;
    const result = upcast(raw);
    if (result.ok) events.push(result.event);
    else newer.push({ type: raw.type, version: raw.version });
  }
  return { events, newer };
}

export function useEvents(from: Origin): Source {
  const [source, setSource] = useState<Source>({ events: [], connection: 'loading', newer: [] });
  // Events arriving together (a load of hundreds, say) are drawn once a frame, not once each.
  const pending = useRef<RawEvent[]>([]);
  const frame = useRef(0);

  useEffect(() => {
    let closed = false;
    const flush = () => {
      frame.current = 0;
      const incoming = pending.current;
      pending.current = [];
      setSource((current) => {
        const { events, newer } = merge(current.events, incoming);
        return { ...current, events, newer: [...current.newer, ...newer] };
      });
    };
    const queue = (raw: RawEvent) => {
      pending.current.push(raw);
      if (!frame.current) frame.current = requestAnimationFrame(flush);
    };
    const set = (connection: Connection) => !closed && setSource((current) => ({ ...current, connection }));

    if (from.kind === 'log') {
      fetch(`${from.base}events.ndjson`)
        .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
        .then((text) => {
          if (closed) return;
          const { events, newer } = merge([], parseLog(text));
          setSource({ events, newer, connection: 'recorded' });
        })
        .catch(() => set('failed'));
      return () => {
        closed = true;
      };
    }

    let stream: EventSource | undefined;
    fetch('/api/events?after=0')
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
      .then((raws: RawEvent[]) => {
        if (closed) return;
        note(raws);
        const { events, newer } = merge([], raws);
        setSource({ events, newer, connection: 'live' });
        // From here on the stream carries everything after the last event held. If it drops, the browser
        // reconnects with the last ID it saw, and the server sends what was missed, once.
        stream = new EventSource(`/api/events/stream?after=${events.at(-1)?.seq ?? 0}`);
        stream.onopen = () => set('live');
        stream.onerror = () => set(stream?.readyState === EventSource.CLOSED ? 'failed' : 'reconnecting');
        stream.onmessage = (message) => {
          const raw = JSON.parse(message.data) as RawEvent;
          note([raw]);
          queue(raw);
        };
      })
      .catch(() => set('failed'));
    return () => {
      closed = true;
      stream?.close();
      cancelAnimationFrame(frame.current);
    };
  }, [from]);

  return source;
}
