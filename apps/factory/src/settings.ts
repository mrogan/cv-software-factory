/**
 * Martin's settings as the factory reads them: the latest `settings.changed` that one of his roles appended, checked
 * against policy as it is read (`policy/settings.ts`), so whatever an event says, only what policy allows is in force.
 * The gateway and the line read them through this; the admin service reads them the same way before it saves.
 *
 * A step runs under the settings in force when its job started, never part-way through one: `forJob` reads them as
 * they stood when the job's token was issued, which the gateway and the line both ask for, so a restart of either reads
 * the same, and the line records what the gateway sent.
 */
import { VERSIONS } from '@software-factory/events';
import { fromMartin } from '@software-factory/store';
import type { Sql, TransactionSql } from 'postgres';
import { type InForce, inForce } from '../../../policy/settings.ts';
import type { Profile } from '../../../policy/spend.ts';

/** How long the gateway trusts the settings in force now before it reads them again, at a check before every call. */
const FRESH_MS = 5_000;
/** How many jobs' settings are kept: more than ever run at once. */
const JOBS_KEPT = 200;

/**
 * The payload of the latest settings event one of Martin's roles appended, that this code can read: up to `at` if
 * given, or up to when a job's token was issued, compared in the store at its own precision; undefined if there is none.
 */
export async function latestChosen(sql: Sql | TransactionSql, at?: Date | { job: string }): Promise<unknown> {
  const upTo =
    at instanceof Date
      ? sql`and e.appended_at <= ${at.toISOString()}::timestamptz`
      : at
        ? sql`and e.appended_at <= (select max(t.issued_at) from job_tokens t where t.job = ${at.job})`
        : sql``;
  const [row] = await sql<{ payload: unknown }[]>`
    select e.payload from events e
    where e.type = 'settings.changed' and e.version <= ${VERSIONS['settings.changed']} and ${fromMartin(sql, 'e')}
      ${upTo}
    order by e.seq desc limit 1`;
  return row?.payload;
}

/** The settings in force on a profile now, read from the store. */
export async function settingsNow(sql: Sql | TransactionSql, profile: Profile): Promise<InForce> {
  return inForce(profile, await latestChosen(sql));
}

export class SettingsReader {
  readonly #sql: Sql;
  readonly #profile: Profile;
  readonly #clock: () => Date;
  readonly #freshMs: number;
  #now: { at: number; settings: Promise<InForce> } | undefined;
  readonly #jobs = new Map<string, Promise<InForce>>();

  /**
   * `freshMs` is how long a read of the settings now is kept: the gateway's few seconds by default, or 0 for the line,
   * which reads them once a pass, and must see a save in the pass the save wakes.
   */
  constructor(sql: Sql, profile: Profile, { clock = () => new Date(), freshMs = FRESH_MS } = {}) {
    this.#sql = sql;
    this.#profile = profile;
    this.#clock = clock;
    this.#freshMs = freshMs;
  }

  get profile(): Profile {
    return this.#profile;
  }

  /** The settings in force now, read again once they are `freshMs` old, or at once when `fresh`. */
  now(fresh = false): Promise<InForce> {
    const at = this.#clock().getTime();
    if (fresh || !this.#now || at - this.#now.at >= this.#freshMs) {
      const settings = settingsNow(this.#sql, this.#profile);
      // A read that failed is read again next time, not kept.
      settings.catch(() => {
        if (this.#now?.settings === settings) this.#now = undefined;
      });
      this.#now = { at, settings };
    }
    return this.#now.settings;
  }

  /**
   * The settings a job runs under: those in force when its token was issued, read once and kept for the job. Undefined
   * for a job with no token.
   */
  async forJob(job: string): Promise<InForce | undefined> {
    const kept = this.#jobs.get(job);
    if (kept) return kept;
    const [row] = await this.#sql`select 1 from job_tokens where job = ${job} limit 1`;
    if (!row) return undefined;
    return this.ofJob(job);
  }

  /** The settings a job whose token the caller holds runs under, read once and kept for the job. */
  ofJob(job: string): Promise<InForce> {
    const kept = this.#jobs.get(job);
    if (kept) return kept;
    const settings = latestChosen(this.#sql, { job }).then((chosen) => inForce(this.#profile, chosen));
    settings.catch(() => this.#jobs.delete(job));
    this.#jobs.set(job, settings);
    // The oldest go first: a Map keeps the order they were set in.
    for (const old of this.#jobs.keys()) {
      if (this.#jobs.size <= JOBS_KEPT) break;
      this.#jobs.delete(old);
    }
    return settings;
  }
}

/**
 * The highest cap on a work item in force at any time since `since`: the gateway holds each work item to the cap in
 * force at each call, so none can have spent more than this.
 */
export async function highestWorkItemCap(sql: Sql, profile: Profile, since: Date): Promise<number> {
  const rows = await sql<{ payload: unknown }[]>`
    select e.payload from events e
    where e.type = 'settings.changed' and e.version <= ${VERSIONS['settings.changed']} and ${fromMartin(sql, 'e')}
      and e.appended_at > ${since.toISOString()}::timestamptz
    order by e.seq`;
  const caps = [await latestChosen(sql, since), ...rows.map((row) => row.payload)].map(
    (chosen) => inForce(profile, chosen).caps.workItemUsd,
  );
  return Math.max(...caps);
}
