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

/** How long the settings in force now are trusted before they are read again. */
const FRESH_MS = 5_000;
/** How many jobs' settings are kept: more than ever run at once. */
const JOBS_KEPT = 200;

/**
 * The payload of the latest settings event one of Martin's roles appended, up to `at` if given, that this code can
 * read; undefined if there is none.
 */
export async function latestChosen(sql: Sql | TransactionSql, at?: Date): Promise<unknown> {
  const [row] = await sql<{ payload: unknown }[]>`
    select e.payload from events e
    where e.type = 'settings.changed' and e.version <= ${VERSIONS['settings.changed']} and ${fromMartin(sql, 'e')}
      ${at ? sql`and e.appended_at <= ${at.toISOString()}::timestamptz` : sql``}
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
  #now: { at: number; settings: Promise<InForce> } | undefined;
  readonly #jobs = new Map<string, Promise<InForce>>();

  constructor(sql: Sql, profile: Profile, clock: () => Date = () => new Date()) {
    this.#sql = sql;
    this.#profile = profile;
    this.#clock = clock;
  }

  get profile(): Profile {
    return this.#profile;
  }

  /** The settings in force now, read again once they are a few seconds old. */
  now(): Promise<InForce> {
    const at = this.#clock().getTime();
    if (!this.#now || at - this.#now.at >= FRESH_MS) {
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
    const [row] = await this.#sql<{ issued_at: Date }[]>`
      select issued_at from job_tokens where job = ${job} order by issued_at desc limit 1`;
    if (!row) return undefined;
    return this.at(job, row.issued_at);
  }

  /** The settings a job runs under, given when its token was issued. */
  at(job: string, issuedAt: Date): Promise<InForce> {
    const kept = this.#jobs.get(job);
    if (kept) return kept;
    const settings = latestChosen(this.#sql, issuedAt).then((chosen) => inForce(this.#profile, chosen));
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
