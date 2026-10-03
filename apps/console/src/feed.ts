/**
 * The feed: every public event, in seq order, held in memory and passed to listeners as it arrives. The server
 * sends events and artifacts and nothing derived from them; the browser does the projecting.
 *
 * Three sources: the event store (live, through LISTEN and NOTIFY), an event-log folder (fixed, as the replay site
 * will be), or nothing at all (an empty store).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRef, RawEvent } from '@software-factory/events';
import { EVENTS_FILE, parseLog, upcast } from '@software-factory/events';
import { listen, readPublic } from '@software-factory/store';
import type { Sql } from 'postgres';
import { log } from './log.ts';

export interface FeedEvent {
  seq: number;
  /** The public event as JSON, encoded once for every client. */
  json: string;
  /** When the store took it, in milliseconds since the epoch. */
  appendedAt: number;
}

export type Listener = (event: FeedEvent) => void;

export class Feed {
  readonly #events: FeedEvent[] = [];
  readonly #listeners = new Set<Listener>();
  /** Every public artifact's recorded type, by hash. The console serves only these. */
  readonly #artifactTypes = new Map<string, string>();

  get lastSeq(): number {
    return this.#events.at(-1)?.seq ?? 0;
  }

  get size(): number {
    return this.#events.length;
  }

  /** The events after a seq, in order. */
  after(seq: number): FeedEvent[] {
    // Seqs only grow, so a binary search finds the first one after.
    let [low, high] = [0, this.#events.length];
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((this.#events[mid]?.seq ?? 0) <= seq) low = mid + 1;
      else high = mid;
    }
    return this.#events.slice(low);
  }

  artifactType(hash: string): string | undefined {
    return this.#artifactTypes.get(hash);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get subscribers(): number {
    return this.#listeners.size;
  }

  /** Adds events in seq order, skipping any it already has, and tells every listener. */
  add(events: readonly { event: RawEvent & { seq: number }; appendedAt: number }[]): void {
    for (const { event, appendedAt } of events) {
      if (event.seq <= this.lastSeq) continue;
      for (const artifact of (event as { artifacts?: ArtifactRef[] }).artifacts ?? []) {
        this.#artifactTypes.set(artifact.hash, artifact.type);
      }
      const added = { seq: event.seq, json: JSON.stringify(event), appendedAt };
      this.#events.push(added);
      for (const listener of this.#listeners) listener(added);
    }
  }
}

/** A feed from the event store, kept current by LISTEN and NOTIFY. Resolves once it has read what is there. */
export async function storeFeed(sql: Sql): Promise<Feed> {
  const feed = new Feed();
  let reading: Promise<void> | undefined;
  let again = false;
  // Notifications can arrive faster than reads finish; one read at a time, and one more if any came meanwhile.
  const catchUp = (): Promise<void> => {
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        for (;;) {
          const page = await readPublic(sql, feed.lastSeq);
          feed.add(page.map(({ event, appendedAt }) => ({ event, appendedAt: appendedAt.getTime() })));
          if (page.length < 1000) break;
        }
      } while (again);
    })()
      .catch((error: unknown) => log.error({ err: error }, 'could not read the event store'))
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  const ready = Promise.withResolvers<void>();
  // onReady runs on the first LISTEN and again after every reconnection: read whatever arrived meanwhile.
  await listen(
    sql,
    () => void catchUp(),
    () => void catchUp().then(ready.resolve),
  );
  await ready.promise;
  log.info({ events: feed.size, last: feed.lastSeq }, 'reading the event store');
  return feed;
}

/** A feed from an event-log folder: what it holds when the server starts, and nothing more. */
export function logFeed(dir: string): Feed {
  const feed = new Feed();
  const events = parseLog(readFileSync(join(dir, EVENTS_FILE), 'utf-8'));
  feed.add(
    events.map((raw) => {
      const result = upcast(raw);
      const event = (result.ok ? result.event : raw) as RawEvent & { seq: number };
      return { event, appendedAt: Date.parse((event as { ts?: string }).ts ?? '') || Date.now() };
    }),
  );
  log.info({ events: feed.size, dir }, 'serving an event log');
  return feed;
}
