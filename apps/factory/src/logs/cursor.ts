/**
 * Where a sense left off. The inbox is never emptied (the inbox counts repeats), so the newest signal a sense left
 * in it says how far that sense had read, and a restarted watcher takes up from there.
 */
import type { Sense } from '@software-factory/events';
import type { Sql } from 'postgres';

/** When the newest signal from the sense says it was observed, or nothing if the sense has left none. */
export async function lastObserved(sql: Sql, sense: Sense): Promise<Date | undefined> {
  const [row] = await sql<{ at: Date | null }[]>`
    select max((signal ->> 'observedAt')::timestamptz) as at from inbox where sense = ${sense}`;
  return row?.at ?? undefined;
}

/**
 * Where reading reports starts: `lateMs` before the last one the inbox holds, for a report written before it that
 * reached Loki after it, or had not yet when the watcher stopped. The inbox drops a report it already holds, by the id
 * it takes from its record. A store with none starts a day back, so reports sent while the factory was away are not
 * lost. Neither starts before the store began to take real work: a report sent to the store before `make real-store`
 * emptied it is not this store's.
 */
export async function reportsFrom(sql: Sql, now: Date, lookbackMs: number, lateMs: number): Promise<Date> {
  const last = await lastObserved(sql, 'report');
  const [store] = await sql<{ chosen_at: Date }[]>`select chosen_at from store where not sample`;
  const from = last ? last.getTime() - lateMs : now.getTime() - lookbackMs;
  return new Date(Math.max(from, store?.chosen_at.getTime() ?? from));
}
