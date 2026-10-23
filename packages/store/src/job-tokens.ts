/**
 * Job tokens (0004_job-tokens-and-agent-calls.sql): what a runner's agent pod holds instead of a credential. The
 * line makes one when it starts a job and ends it when the job ends; the gateway and the handback accept it for that
 * work item and that agent only, while it lasts. The store keeps its SHA-256, never the token.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Sql } from 'postgres';

export interface JobToken {
  job: string;
  workItem: string;
  agent: string;
  /**
   * The step's span, as a W3C `traceparent`, which the gateway starts the job's model calls under: absent when the
   * token was made with no span in hand, or before the store had the column for it (read as a row's JSON, so a store
   * without it reads as none).
   */
  traceparent?: string;
}

/** A job token the store holds, with when it was issued: the settings a job runs under are those in force then. */
export interface IssuedJobToken extends JobToken {
  issuedAt: Date;
}

/**
 * A token is 32 random bytes, not a password: nobody can guess one, so a fast hash keeps it safe at rest, as GitHub
 * keeps its tokens. A slow, salted hash would cost every model call a few hundred milliseconds and protect nothing more.
 */
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

/** Postgres's code for a column that is not there. */
const UNDEFINED_COLUMN = '42703';

/** Makes a job's token. It is shown once, here: give it to the job's pod and keep it nowhere else. */
export async function issueJobToken(sql: Sql, job: JobToken): Promise<string> {
  const token = `sfj_${randomBytes(32).toString('base64url')}`;
  try {
    await sql`insert into job_tokens (token_sha256, job, work_item, agent, traceparent)
              values (${hashOf(token)}, ${job.job}, ${job.workItem}, ${job.agent}, ${job.traceparent ?? null})`;
  } catch (error) {
    // A store the console's image has not migrated yet (0021) has no trace column: the token is made without it.
    if ((error as { code?: string }).code !== UNDEFINED_COLUMN) throw error;
    await sql`insert into job_tokens (token_sha256, job, work_item, agent)
              values (${hashOf(token)}, ${job.job}, ${job.workItem}, ${job.agent})`;
  }
  return token;
}

/** The job a token is for, while the job has not ended; otherwise undefined. */
export async function jobForToken(sql: Sql, token: string): Promise<IssuedJobToken | undefined> {
  if (!token.startsWith('sfj_')) return undefined;
  const [row] = await sql<
    { job: string; work_item: string; agent: string; issued_at: Date; traceparent: string | null }[]
  >`
    select job, work_item, agent, issued_at, to_jsonb(t) ->> 'traceparent' as traceparent from job_tokens t
    where token_sha256 = ${hashOf(token)} and ended_at is null`;
  return (
    row && {
      job: row.job,
      workItem: row.work_item,
      agent: row.agent,
      issuedAt: row.issued_at,
      ...(row.traceparent ? { traceparent: row.traceparent } : {}),
    }
  );
}

/** Ends a job's token, so neither the gateway nor the handback accepts it again. Ending one twice does nothing. */
export async function endJobToken(sql: Sql, job: string): Promise<void> {
  await sql`update job_tokens set ended_at = clock_timestamp() where job = ${job} and ended_at is null`;
}
