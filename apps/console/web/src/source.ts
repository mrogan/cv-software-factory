/**
 * Where the console's events come from. The page's `sf-events` meta tag says: "live" reads this server's events
 * and follows them as they arrive; "log:<folder>" reads an event-log folder once, as the replay site does. Live, the
 * events are the public ones from the console's server, or, for Martin signed in, the full ones from the admin
 * service. The projection cannot tell which; this module is the only part that knows.
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
  /** The events could not be read at all; the console keeps trying. */
  | 'failed';

/**
 * What the store holds, as the server says when the stream opens: samples, real events, or neither decided yet.
 * Undefined until it has said. A recording says nothing: its events speak for themselves.
 */
export type StoreKind = 'sample' | 'real' | null;

export interface Source {
  events: PublicEvent[];
  connection: Connection;
  store: StoreKind | undefined;
  /** Events written by a newer factory than this console, which it leaves out rather than guess at. */
  newer: { type: string; version: number }[];
}

export type Origin = { kind: 'live' } | { kind: 'log'; base: string };

/**
 * Which events, live: the public ones every visitor gets from the console's server (`/api/events`, then
 * `/api/events/stream`), or the full ones the admin service streams to Martin's session (`/admin/events/stream`).
 */
export type Stream = 'public' | 'full';

/** How long to wait before trying the server again. */
const RETRY_MS = 5000;

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

/**
 * The events, as they arrive. `want` says which, live; `lost` is asked when the full stream ends or is refused, and
 * says whether Martin is still signed in, to open it again, or not, when the page goes back to the public events.
 */
export function useEvents(from: Origin, want: Stream = 'public', lost?: () => Promise<boolean>): Source {
  const [source, setSource] = useState<Source>({ events: [], connection: 'loading', newer: [], store: undefined });
  // Events arriving together (a load of hundreds, say) are drawn once a frame, not once each.
  const pending = useRef<RawEvent[]>([]);
  const frame = useRef(0);
  // What is drawn now, for the full stream to take over from without a blank page between.
  const drawn = useRef(source);
  drawn.current = source;
  // The full events wait for the public stream to say what kind of store it is, which only it says.
  const reading: Stream = want === 'full' && source.store !== undefined ? 'full' : 'public';
  // Whether any full event has been drawn: going back to the public events then starts again from nothing.
  const full = useRef(false);
  const onLost = useRef(lost);
  onLost.current = lost;

  useEffect(() => {
    let closed = false;
    // How incoming events join what is drawn: the public ones after it, the full ones in its place (below).
    let apply = (incoming: RawEvent[]) =>
      setSource((current) => {
        const { events, newer } = merge(current.events, incoming);
        return { ...current, events, newer: [...current.newer, ...newer] };
      });
    const flush = () => {
      frame.current = 0;
      const incoming = pending.current;
      pending.current = [];
      apply(incoming);
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
          setSource({ events, newer, connection: 'recorded', store: null });
        })
        .catch(() => set('failed'));
      return () => {
        closed = true;
      };
    }

    let stream: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let last = 0;
    const stop = () => {
      closed = true;
      stream?.close();
      clearTimeout(retry);
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      pending.current = [];
    };

    if (reading === 'full') {
      // The full events take over from the public ones as they arrive, event by event: each has the same seq as its
      // public view, so until the stream has caught up the page shows the public events after the last full one.
      full.current = true;
      const before = drawn.current.events;
      let held: PublicEvent[] = [];
      // What the public events held that this console doesn't understand stays said until the full ones say it too.
      const said = (newer: Source['newer']) =>
        newer.filter((n, i) => newer.findIndex((m) => m.type === n.type && m.version === n.version) === i);
      let notUnderstood: Source['newer'] = drawn.current.newer;
      apply = (incoming) => {
        const merged = merge(held, incoming);
        held = merged.events;
        notUnderstood = said([...notUnderstood, ...merged.newer]);
        // Every event the stream has sent so far, understood or not, replaces its public view.
        const rest = before.filter((event) => event.seq > last);
        setSource((current) => ({ ...current, events: [...held, ...rest], newer: notUnderstood }));
      };
      const follow = () => {
        stream = new EventSource(`/admin/events/stream?after=${last}`);
        stream.onopen = () => set('live');
        // The session ended (signed out, revoked or expired), or the service is stopping: ask before going on.
        const ask = () => {
          stream?.close();
          set('reconnecting');
          void (onLost.current?.() ?? Promise.resolve(false)).then((live) => {
            if (live && !closed) retry = setTimeout(follow, RETRY_MS);
          });
        };
        stream.addEventListener('ended', ask);
        stream.onerror = () => {
          set('reconnecting');
          // Refused (no session: a 401), or the service failed: the browser gives up, and so asks.
          if (stream?.readyState === EventSource.CLOSED) ask();
        };
        stream.onmessage = (message) => {
          const raw = JSON.parse(message.data) as RawEvent;
          note([raw]);
          last = Math.max(last, raw.seq ?? 0);
          queue(raw);
        };
      };
      follow();
      return stop;
    }

    // Back from the full events (a preview, or a session that ended): nothing of them stays drawn.
    if (full.current) {
      full.current = false;
      setSource((current) => ({ ...current, events: [], newer: [], connection: 'loading' }));
    }
    // From the first read on, the stream carries everything after the last event held. If it drops, the browser
    // reconnects with the last ID it saw and the server sends what was missed, once. If the browser gives up (the
    // server answered with an error), this starts a new stream from the last event held.
    const follow = () => {
      stream = new EventSource(`/api/events/stream?after=${last}`);
      stream.onopen = () => set('live');
      // The server's first word on a stream is the store's kind: not an event, so the schema needn't carry it.
      stream.addEventListener('store', (message) => {
        const { kind } = JSON.parse((message as MessageEvent<string>).data) as { kind: StoreKind };
        if (!closed) setSource((current) => (current.store === kind ? current : { ...current, store: kind }));
      });
      stream.onerror = () => {
        set('reconnecting');
        if (stream?.readyState !== EventSource.CLOSED) return;
        stream.close();
        retry = setTimeout(follow, RETRY_MS);
      };
      stream.onmessage = (message) => {
        const raw = JSON.parse(message.data) as RawEvent;
        note([raw]);
        last = Math.max(last, raw.seq ?? 0);
        queue(raw);
      };
    };
    const read = () => {
      fetch('/api/events?after=0')
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
        .then((raws: RawEvent[]) => {
          if (closed) return;
          note(raws);
          const { events, newer } = merge([], raws);
          // Everything read, understood or not: the stream must not send a newer factory's events again.
          last = raws.at(-1)?.seq ?? 0;
          setSource((current) => ({ ...current, events, newer, connection: 'live' }));
          follow();
        })
        .catch(() => {
          if (closed) return;
          set('failed');
          retry = setTimeout(read, RETRY_MS);
        });
    };
    read();
    return stop;
  }, [from, reading]);

  // Back from the full events, nothing of them is drawn, not even for the frame before the effect clears them.
  if (reading === 'public' && full.current) return { ...source, events: [], newer: [], connection: 'loading' };

  return source;
}
