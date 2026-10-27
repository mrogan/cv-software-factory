/**
 * The feature flags as the store tells them: the one reader of a flag's state that the admin service, judging a move,
 * and the line, judging each flag at its stage (Verify by variant), share, so both read the same thing from the same
 * sources. The console reads the same events from the public log, and folds them with the same `flagsFrom`.
 *
 * - **Martin's moves:** `flag.staged`, appended by one of his roles, on a work item. A move another role appended is
 *   none of his, and an event stored before the store recorded who appended each says nothing of who did.
 * - **Verify's comparisons:** `flag.compared`, appended by the line's role.
 * - **Which flag is whose:** the latest spec the line's role wrote for each improvement, and the flag it names; of two
 *   improvements whose latest specs name the same flag, the later spec's.
 * - **Which work items closed as turned off,** and are closed still, as the line closes one when Martin turns its flag
 *   off: its flag stays off, but for going straight back to Everyone.
 *
 * Samples are never read: a sample's flag is no flag of the app's.
 */
import { VERSIONS } from '@software-factory/events';
import type { Sql, TransactionSql } from 'postgres';
import type { FlagRecord } from '../../../policy/flag-moves.ts';
import { fromMartin } from './commands.ts';

/** The role whose events of Verify's, and records of the planner's specs, are believed: the line's. */
export const LINE_ROLE = 'factory_line';

/** A flag's event, as `flagsFrom` folds it, with its place in the store and, for Martin's move, his reason. */
export type StoredFlagRecord = FlagRecord & { seq: string; reason?: string };

export interface FlagEvents {
  /** Each flag an improvement's latest spec names, and that improvement's work item. */
  named: Record<string, string>;
  /** Martin's moves and Verify's comparisons, oldest first. */
  records: StoredFlagRecord[];
  /** The work items Martin's moves were staged on that closed as turned off, and are closed still. */
  closed: string[];
}

/** What the store says of the flags, or of one flag alone. */
export async function flagEvents(sql: Sql | TransactionSql, flag?: string): Promise<FlagEvents> {
  const named = await sql<{ work_item: string; flag: string }[]>`
    with specs as (
      select distinct on (s.work_item) s.work_item, s.seq, s.payload->>'flag' as flag
      from events s
      where s.type = 'spec.written' and s.appended_by = ${LINE_ROLE} and s.work_item is not null and not s.sample
        ${
          flag === undefined
            ? sql``
            : sql`and s.work_item in (select n.work_item from events n
                                      where n.type = 'spec.written' and n.payload->>'flag' = ${flag})`
        }
      order by s.work_item, s.seq desc
    )
    select p.work_item, p.flag from specs p
    where p.flag is not null ${flag === undefined ? sql`` : sql`and p.flag = ${flag}`}
      and exists (select 1 from events o where o.type = 'work-item.opened' and o.work_item = p.work_item
                  and o.payload->>'kind' = 'improvement' and not o.sample)
    order by p.seq`;
  const rows = await sql<{ seq: string; type: 'flag.staged' | 'flag.compared'; work_item: string; payload: never }[]>`
    select e.seq::text as seq, e.type, e.work_item, e.payload from events e
    where e.type in ('flag.staged', 'flag.compared') and not e.sample
      ${flag === undefined ? sql`` : sql`and e.payload->>'flag' = ${flag}`}
      and ((e.type = 'flag.staged' and e.version <= ${VERSIONS['flag.staged']} and e.work_item is not null
            and e.appended_by is not null and ${fromMartin(sql, 'e')})
        or (e.type = 'flag.compared' and e.version <= ${VERSIONS['flag.compared']} and e.appended_by = ${LINE_ROLE}))
    order by e.seq`;
  const records = rows.map(({ seq, type, work_item, payload }): StoredFlagRecord => {
    if (type === 'flag.staged') {
      const { flag, from, to, reason } = payload as Pick<
        Extract<FlagRecord, { type: 'flag.staged' }>,
        'flag' | 'from' | 'to'
      > & { reason?: string };
      return { type, seq, flag, workItem: work_item, from, to, ...(reason !== undefined && { reason }) };
    }
    const { flag, share, outcome } = payload as Omit<Extract<FlagRecord, { type: 'flag.compared' }>, 'type'>;
    return { type, seq, flag, share, outcome };
  });
  const staged = [...new Set(records.flatMap((r) => (r.type === 'flag.staged' ? [r.workItem] : [])))];
  const closed = staged.length
    ? await sql<{ work_item: string }[]>`
        select c.work_item from events c
        where c.type = 'work-item.closed' and c.payload->>'outcome' = 'turned-off' and c.work_item = any(${staged})
          and c.seq = (select max(l.seq) from events l where l.work_item = c.work_item
                       and l.type in ('work-item.closed', 'work-item.reopened'))`
    : [];
  return {
    named: Object.fromEntries(named.map((row) => [row.flag, row.work_item])),
    records,
    closed: closed.map((row) => row.work_item),
  };
}
