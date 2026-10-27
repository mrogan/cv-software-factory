/**
 * The feature flags as the store tells them: the one reader of a flag's state that the admin service, judging a move,
 * and the line, judging each flag at its stage (Verify by variant), share, so both read the same thing from the same
 * sources. The console reads the same events from the public log, and folds them with the same `flagsFrom`.
 *
 * - **Martin's moves:** `flag.staged`, appended by one of his roles, on a work item. A move another role appended is
 *   none of his, and an event stored before the store recorded who appended each says nothing of who did.
 * - **Verify's comparisons:** `flag.compared`, appended by the line's role.
 * - **Verify's checks with the probes:** `flag.checked`, appended by the line's role, at Off, Checks and Preview.
 * - **Which flag is whose:** the latest spec the line's role wrote for each improvement, and the flag it names; of two
 *   improvements whose latest specs name the same flag, the later spec's.
 *
 * Samples are never read: a sample's flag is no flag of the app's.
 */
import { type PayloadOf, VERSIONS } from '@software-factory/events';
import type { Sql, TransactionSql } from 'postgres';
import type { FlagRecord } from '../../../policy/flag-moves.ts';
import { fromMartin } from './commands.ts';

/** The role whose events of Verify's, and records of the planner's specs, are believed: the line's. */
export const LINE_ROLE = 'factory_line';

/**
 * A flag's event, as `flagsFrom` folds it, with its place in the store, when it happened (from which the line's Verify
 * times a share's window), and, for Martin's move, his reason.
 */
export type StoredFlagRecord = FlagRecord & { seq: string; ts: string; reason?: string };

/** Verify's check of a flag with the probes, with its place in the store and the work item it is on. */
export interface StoredFlagCheck {
  seq: string;
  ts: string;
  workItem: string;
  check: PayloadOf<'flag.checked'>;
}

export interface FlagEvents {
  /** Each flag an improvement's latest spec names, and that improvement's work item. */
  named: Record<string, string>;
  /** Martin's moves, and Verify's comparisons, checks and baselines, oldest first. */
  records: StoredFlagRecord[];
  /** Verify's checks with the probes, the baselines with the flag off too, oldest first. */
  checked: StoredFlagCheck[];
  /** The revision of the flag set Martin's latest move of any flag wrote, or null before his first. */
  revision: string | null;
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
  const rows = await sql<
    {
      seq: string;
      ts: Date;
      type: 'flag.staged' | 'flag.compared' | 'flag.checked';
      work_item: string;
      payload: never;
    }[]
  >`
    select e.seq::text as seq, e.ts, e.type, e.work_item, e.payload from events e
    where e.type in ('flag.staged', 'flag.compared', 'flag.checked') and not e.sample
      ${flag === undefined ? sql`` : sql`and e.payload->>'flag' = ${flag}`}
      and ((e.type = 'flag.staged' and e.version <= ${VERSIONS['flag.staged']} and e.work_item is not null
            and e.appended_by is not null and ${fromMartin(sql, 'e')})
        or (e.type = 'flag.compared' and e.version <= ${VERSIONS['flag.compared']} and e.appended_by = ${LINE_ROLE})
        or (e.type = 'flag.checked' and e.version <= ${VERSIONS['flag.checked']} and e.appended_by = ${LINE_ROLE}
            and e.work_item is not null))
    order by e.seq`;
  const checked = rows
    .filter((row) => row.type === 'flag.checked')
    .map(
      ({ seq, ts, work_item, payload }): StoredFlagCheck => ({
        seq,
        ts: ts.toISOString(),
        workItem: work_item,
        check: payload as PayloadOf<'flag.checked'>,
      }),
    );
  // The flag set as it stands is the one Martin's latest move of any flag wrote, whichever flag was asked about.
  const [latest] = await sql<{ revision: string }[]>`
    select e.payload->>'revision' as revision from events e
    where e.type = 'flag.staged' and not e.sample and e.version <= ${VERSIONS['flag.staged']}
      and e.work_item is not null and e.appended_by is not null and ${fromMartin(sql, 'e')}
    order by e.seq desc limit 1`;
  const records = rows.flatMap(({ seq, ts: at, type, work_item, payload }): StoredFlagRecord[] => {
    const ts = at.toISOString();
    if (type === 'flag.checked') {
      // A baseline lets Checks be taken for its improvement; a check at Checks or Preview, a widening past it.
      const check = payload as PayloadOf<'flag.checked'>;
      if (check.stage === 'off') return [{ type, seq, ts, flag: check.flag, stage: 'off', workItem: work_item }];
      const { flag, stage, outcome, moveRevision } = check;
      return [{ type, seq, ts, flag, stage, outcome, moveRevision }];
    }
    if (type === 'flag.staged') {
      const { flag, from, to, revision, reason } = payload as PayloadOf<'flag.staged'>;
      return [
        { type, seq, ts, flag, workItem: work_item, from, to, revision, ...(reason !== undefined && { reason }) },
      ];
    }
    const { flag, share, outcome, moveRevision } = payload as PayloadOf<'flag.compared'>;
    return [{ type, seq, ts, flag, share, outcome, moveRevision }];
  });
  return {
    named: Object.fromEntries(named.map((row) => [row.flag, row.work_item])),
    records,
    checked,
    revision: latest?.revision ?? null,
  };
}
