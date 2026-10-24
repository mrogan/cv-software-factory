/**
 * Martin's commands, as the workers read them. Row security lets only his roles append an admin event
 * (`0023_martins-commands.sql`), and the store records the role that appended each, so an event that says
 * `actor: martin` proves nothing by itself: the line, triage and the gateway act on an admin event only when one of
 * his roles appended it, and log any other once.
 */
import { ADMIN_TYPES } from '@software-factory/events';
import type { Sql, TransactionSql } from 'postgres';
import { MARTINS_ROLES } from '../../../policy/store-grants.ts';

/**
 * SQL, true for an event the factory may act on: any but an admin event, and an admin event that one of Martin's roles
 * appended, or that was stored before the store recorded who appended each (it has none). `alias` names the events in
 * the query around it, such as `a`.
 */
export const fromMartin = (sql: Sql | TransactionSql, alias: string) =>
  sql`(${sql(`${alias}.type`)} <> all(${[...ADMIN_TYPES]})
       or ${sql(`${alias}.appended_by`)} is null
       or ${sql(`${alias}.appended_by`)} = any(${MARTINS_ROLES}))`;

/**
 * Whether the line is stopped: the last of `line.started` and `line.stopped` that one of Martin's roles appended
 * decides. Every worker asks before it takes work.
 */
export async function lineStopped(sql: Sql | TransactionSql): Promise<boolean> {
  const [last] = await sql<{ type: string }[]>`
    select e.type from events e where e.type in ('line.started', 'line.stopped') and ${fromMartin(sql, 'e')}
    order by e.seq desc limit 1`;
  return last?.type === 'line.stopped';
}

interface Log {
  warn(details: object, message: string): void;
}

/** An admin event a role not Martin's appended, which the factory ignores. */
export interface Ignored {
  seq: number;
  type: string;
  actor: string;
  appendedBy: string;
}

/**
 * Logs each admin event a role not Martin's appended, once, from the first it has not looked at. Row security refuses
 * them, so one here means that guard failed.
 */
export class IgnoredCommands {
  readonly #sql: Sql;
  readonly #log: Log;
  #after = 0;
  /** The look in progress: calls at once share it, so none logs an event another is logging. */
  #looking: Promise<Ignored[]> | undefined;

  constructor(sql: Sql, log: Log) {
    this.#sql = sql;
    this.#log = log;
  }

  /** Looks at the events appended since it last looked, and returns those it ignored. */
  check(): Promise<Ignored[]> {
    this.#looking ??= this.#look().finally(() => {
      this.#looking = undefined;
    });
    return this.#looking;
  }

  async #look(): Promise<Ignored[]> {
    const sql = this.#sql;
    const [top] = await sql<{ seq: string | null }[]>`select max(seq) as seq from events`;
    const upTo = Number(top?.seq ?? 0);
    if (upTo <= this.#after) return [];
    const rows = await sql<{ seq: string; type: string; actor: string; appended_by: string }[]>`
      select e.seq, e.type, e.actor, e.appended_by from events e
      where e.seq > ${this.#after} and e.seq <= ${upTo} and not ${fromMartin(sql, 'e')}
      order by e.seq`;
    this.#after = upTo;
    const ignored = rows.map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      actor: row.actor,
      appendedBy: row.appended_by,
    }));
    for (const event of ignored) {
      this.#log.warn(
        event,
        `ignored ${event.type}: ${event.appendedBy} appended it, and it is not one of Martin's roles`,
      );
    }
    return ignored;
  }
}
