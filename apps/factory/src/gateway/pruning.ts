/**
 * Pruning the cassettes a recording gateway keeps. On the cluster the gateway records every call and replays none
 * (`record`), so a cassette there is the record of what a call sent and got back, for looking into a run, and it is
 * kept while a run might still be looked into: two weeks (`CASSETTES` in policy/cassettes.ts) after the work items its
 * calls name have closed.
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
 * One recording with no TypeSafe key replays Jev's calls from it, so it keeps Jev's cassettes, and a file no call
 * names, which could be one of them, for longer.
 *
 * But never past a visitor's report's time (`REPORT_TEXT` in policy/triage.ts): a cassette of Jev's holds the report
 * it judged, so one goes once it has gone `REPORT_TEXT.keepDays` unwritten and uncalled, whatever the work items its
 * calls name and in either case; so does a file no call names, which could hold one.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { lastEnd } from '@software-factory/store';
import type { Sql } from 'postgres';
import { CASSETTES } from '../../../../policy/cassettes.ts';
import { REPORT_TEXT } from '../../../../policy/triage.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const CASSETTE = /^([0-9a-f]{64})\.json$/;
/** A cassette half written: `<key>.json.<pid>.tmp`, which a gateway stopped mid-write leaves behind. */
const PARTIAL = /^[0-9a-f]{64}\.json\.\d+\.tmp$/;

export interface PruneOptions {
  sql: Sql;
  /** The folder the gateway records cassettes in. */
  dir: string;
  /**
   * Only agents' cassettes: a gateway with no TypeSafe key replays Jev's calls from the folder, so it keeps theirs,
   * and a file no call names, which could be one of them.
   */
  agentsOnly?: boolean;
  now?: Date;
  keepDays?: number;
  /** How long a cassette that may hold a visitor's report is kept at most. */
  reportDays?: number;
}

/** What a prune did: the files it deleted, and those it could not. */
export interface Pruned {
  deleted: number;
  failed: number;
}

/** Deletes the cassettes no longer kept (see the top of this file). */
export async function pruneCassettes({
  sql,
  dir,
  agentsOnly = false,
  now = new Date(),
  keepDays = CASSETTES.keepDays,
  reportDays = REPORT_TEXT.keepDays,
}: PruneOptions): Promise<Pruned> {
  const before = new Date(now.getTime() - keepDays * DAY_MS);
  const reportsBefore = new Date(now.getTime() - reportDays * DAY_MS);
  // A file unwritten since the later of the two is due by one rule or the other, or by neither.
  const either = new Date(Math.max(before.getTime(), reportsBefore.getTime()));
  const unwritten = async (name: string, since: Date) => {
    const written = await stat(join(dir, name)).catch(() => undefined);
    return written?.isFile() === true && written.mtime < since;
  };
  // Only a file unwritten for as long is considered, and it is looked at again just before it goes: one written since
  // its calls were read stays.
  const old: { name: string; key: string | undefined }[] = [];
  for (const name of await readdir(dir).catch(notFound)) {
    const key = CASSETTE.exec(name)?.[1];
    if (!key && !PARTIAL.test(name)) continue;
    if (await unwritten(name, either)) old.push({ name, key });
  }
  const keys = old.flatMap(({ key }) => (key ? [key] : []));
  const named = keys.length ? await dueOf(sql, keys, before, reportsBefore, agentsOnly) : new Map<string, Due>();
  const pruned: Pruned = { deleted: 0, failed: 0 };
  for (const { name, key } of old) {
    const calls = key ? named.get(key) : undefined;
    // A file no call names goes, unless it could be a judgement replayed from here; but not past a report's time.
    const since = calls
      ? latest([...(calls.usual ? [before] : []), ...(calls.report ? [reportsBefore] : [])])
      : agentsOnly
        ? reportsBefore
        : either;
    if (!since) continue;
    if (!(await unwritten(name, since))) continue;
    try {
      await rm(join(dir, name), { force: true });
      pruned.deleted++;
    } catch {
      // One that cannot go leaves the rest to: the next prune tries it again.
      pruned.failed++;
    }
  }
  return pruned;
}

/** Which rules a cassette some call names is due to go by: the usual one, the report rule, both or neither. */
interface Due {
  usual: boolean;
  report: boolean;
}

/** The latest of these dates, or none. */
const latest = (dates: Date[]): Date | undefined =>
  dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : undefined;

/**
 * Of these cassettes, each some call names, and whether it is due to go: not with a call since `before`, nor for a
 * work item not closed as long (its last end is not a close, as `lastEnd` has it, or its last close was appended
 * since). With `agentsOnly`, one any judgement names is not due by that rule. One any judgement names is due anyway
 * with no call since `reportsBefore`, as it may hold a visitor's report.
 */
async function dueOf(
  sql: Sql,
  keys: string[],
  before: Date,
  reportsBefore: Date,
  agentsOnly: boolean,
): Promise<Map<string, Due>> {
  const rows = await sql<{ cassette: string; due: boolean; report: boolean }[]>`
    with calls as (
      select cassette, max(at) as last_call, bool_and(question_set = 'messages') as agents,
             array_agg(distinct work_item) filter (where work_item is not null) as items
      from model_calls where cassette = any(${keys}::text[]) group by cassette
    ),
    items as (select distinct unnest(items) as work_item from calls),
    open as (
      select work_item from items
      where ${lastEnd(sql, 'items.work_item')} is distinct from 'work-item.closed'
         or (select max(appended_at) from events closed
             where closed.work_item = items.work_item and closed.type = 'work-item.closed') >= ${before}
    )
    select cassette,
           last_call < ${before} and (agents or not ${agentsOnly})
             and not exists (select 1 from open where open.work_item = any(calls.items)) as due,
           not agents and last_call < ${reportsBefore} as report
    from calls`;
  return new Map(rows.map((row) => [row.cassette, { usual: row.due, report: row.report }]));
}

const notFound = (error: NodeJS.ErrnoException): string[] => {
  // A gateway that has recorded nothing yet has no folder.
  if (error.code === 'ENOENT') return [];
  throw error;
};

export interface Pruner {
  stop(): Promise<void>;
}

/** Prunes now and every `CASSETTES.pruneHours`, logging what went and what failed, until stopped. */
export function startPruning(
  options: Omit<PruneOptions, 'now'>,
  log: { info(fields: object, message: string): void; warn(fields: object, message: string): void },
  everyMs = CASSETTES.pruneHours * 60 * 60 * 1000,
): Pruner {
  let pruning: Promise<void> | undefined;
  // One prune at a time: a tick that finds one still running leaves it be.
  const prune = () => {
    if (pruning) return;
    pruning = pruneCassettes(options)
      .then(
        ({ deleted, failed }) => {
          if (deleted) log.info({ deleted }, 'deleted the cassettes no longer kept');
          if (failed) log.warn({ failed }, 'could not delete some cassettes: the next prune tries again');
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
