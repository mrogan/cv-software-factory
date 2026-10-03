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
