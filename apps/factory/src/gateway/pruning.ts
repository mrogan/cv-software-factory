/**
 * Pruning the cassettes a recording gateway keeps. On the cluster the gateway records every call and replays none
 * (`record`), so a cassette there is the record of what a call sent and got back, for looking into a run, and it is
 * kept while a run might still be looked into: two weeks after the work items its calls name have closed.
 *
 * A cassette is deleted once it has gone two weeks unwritten and
 *
 * - its calls name work items, and every one of them has been closed for two weeks (the last of a work item's closes
 *   and reopenings is a close, as `lastEnd` in packages/store has it, appended that long ago), and its last call is
 *   that old too;
 * - or its calls name no work item, such as triage judging a visitor's report before there is a ticket, and its last
 *   call is two weeks old;
 * - or no call names it, such as a file left by a write that never finished.
 *
 * Rows in `model_calls` stay: the ledger is never changed, and a call's cassette may name a file that has gone. Only
 * the folder the gateway records in is pruned, never the folders it reads besides, such as the committed evaluation
 * cassettes. A gateway that replays from its folder keeps everything: there a cassette is an answer to give again.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Sql } from 'postgres';

/** How long a cassette is kept after the last thing it was for, in days. */
export const KEEP_DAYS = 14;

/** How often the gateway prunes, in hours. Once as it starts, too. */
export const PRUNE_HOURS = 6;

const DAY_MS = 24 * 60 * 60 * 1000;
const CASSETTE = /^([0-9a-f]{64})\.json$/;
/** A cassette half written: `<key>.json.<pid>.tmp`, which a gateway stopped mid-write leaves behind. */
const PARTIAL = /^[0-9a-f]{64}\.json\.\d+\.tmp$/;

export interface PruneOptions {
  sql: Sql;
  /** The folder the gateway records cassettes in. */
  dir: string;
  now?: Date;
  keepDays?: number;
}

/** Deletes the cassettes no longer kept (see the top of this file), and returns how many went. */
export async function pruneCassettes({ sql, dir, now = new Date(), keepDays = KEEP_DAYS }: PruneOptions) {
  const before = new Date(now.getTime() - keepDays * DAY_MS);
  // Only a file unwritten for as long is considered: one written since a call's row was read is never deleted.
  const old: { name: string; key: string | undefined }[] = [];
  for (const name of await readdir(dir).catch(notFound)) {
    const key = CASSETTE.exec(name)?.[1];
    if (!key && !PARTIAL.test(name)) continue;
    const written = await stat(join(dir, name)).catch(() => undefined);
    if (written?.isFile() && written.mtime < before) old.push({ name, key });
  }
  const keys = old.flatMap(({ key }) => (key ? [key] : []));
  const kept = new Set(keys.length ? await stillKept(sql, keys, before) : []);
  let deleted = 0;
  for (const { name, key } of old) {
    if (key && kept.has(key)) continue;
    await rm(join(dir, name), { force: true });
    deleted++;
  }
  return deleted;
}

/** Of these cassettes, those some call still keeps: one made since `before`, or for a work item not closed as long. */
async function stillKept(sql: Sql, keys: string[], before: Date): Promise<string[]> {
  const rows = await sql<{ cassette: string }[]>`
    with calls as (
      select cassette, max(at) as last_call, array_agg(distinct work_item) filter (where work_item is not null) as items
      from model_calls where cassette = any(${keys}::text[]) group by cassette
    ),
    items as (select distinct unnest(items) as work_item from calls),
    ends as (
      select items.work_item, last_end.type, last_end.appended_at
      from items left join lateral (
        select type, appended_at from events
        where events.work_item = items.work_item and type in ('work-item.closed', 'work-item.reopened')
        order by seq desc limit 1
      ) last_end on true
    )
    select cassette from calls
    where last_call >= ${before}
       or exists (select 1 from ends where ends.work_item = any(calls.items)
                  and (ends.type is distinct from 'work-item.closed' or ends.appended_at >= ${before}))`;
  return rows.map((row) => row.cassette);
}

const notFound = (error: NodeJS.ErrnoException): string[] => {
  // A gateway that has recorded nothing yet has no folder.
  if (error.code === 'ENOENT') return [];
  throw error;
};

export interface Pruner {
  stop(): Promise<void>;
}

/** Prunes now and every `PRUNE_HOURS`, logging what went and what failed, until stopped. */
export function startPruning(
  options: Omit<PruneOptions, 'now'>,
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void },
  everyMs = PRUNE_HOURS * 60 * 60 * 1000,
): Pruner {
  let pruning: Promise<void> | undefined;
  // One prune at a time: a tick that finds one still running leaves it be.
  const prune = () => {
    if (pruning) return;
    pruning = pruneCassettes(options)
      .then(
        (deleted) => {
          if (deleted) log.info({ deleted }, 'deleted the cassettes no longer kept');
        },
        // The next prune tries again; the folder only grows meanwhile.
        (error) => log.warn({ err: error }, 'could not prune the cassettes'),
      )
      .finally(() => {
        pruning = undefined;
      });
  };
  prune();
  const timer = setInterval(prune, everyMs);
  return {
    async stop() {
      clearInterval(timer);
      await pruning;
    },
  };
}
