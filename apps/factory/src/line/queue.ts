/**
 * The line's queue in Postgres (0005_line.sql): which work items are on the line, at which stage, and which worker
 * holds each, under a lease as the inbox's signals are held. What a work item has done is in its events; this is
 * only where it waits, who is acting on it, and what the line needs that no event carries.
 *
 * A ticket comes onto the line only when nothing is in Plan or waiting for Build, so the line pulls work at the
 * pace of its slowest step rather than piling up specs: the oldest open ticket of the highest severity, from the
 * real events only. One decision at a time takes it (an advisory lock), so two workers cannot take the same ticket.
 */
import type { JSONValue, Sql } from 'postgres';
import type { Handback } from '../runners/steps.ts';
import type { Draft } from './gates.ts';
import type { LineAgent, QueueStage } from './machine.ts';

/** A handback whose effects are not all done yet, kept so they can be tried again without the agent. */
export interface Pending {
  agent: LineAgent;
  round: number;
  job: string;
  /** The last of the work item's events when the step started. One appended since makes this out of date. */
  since: number;
  commit: string;
  base: string;
  handback: Handback;
  /** The step's `model.called`, appended with the effects' events. */
  called: Draft[];
  /** The writes begun, and what each one done gave back, by name. */
  begun: string[];
  done: Record<string, JSONValue>;
  /** Failed tries at the effects, why the last one failed, and when to try again. */
  tries: number;
  failure: string | null;
  retryAt: string | null;
}

export interface QueueItem {
  workItem: string;
  stage: QueueStage;
  /** Every step started for it so far. */
  steps: number;
  failures: number;
  failure: string | null;
  issue: number | null;
  session: string | null;
  effects: Pending | null;
}

interface Row {
  work_item: string;
  stage: QueueStage;
  steps: number;
  failures: number;
  failure: string | null;
  issue: number | null;
  session: string | null;
  effects: Pending | null;
}

const item = (row: Row): QueueItem => ({
  workItem: row.work_item,
  stage: row.stage,
  steps: row.steps,
  failures: row.failures,
  failure: row.failure,
  issue: row.issue,
  session: row.session,
  effects: row.effects,
});

const COLUMNS = ['work_item', 'stage', 'steps', 'failures', 'failure', 'issue', 'session', 'effects'];

export class Queue {
  readonly #sql: Sql;
  /** Who this worker is, as its leases name it. */
  readonly #me: string;

  constructor(sql: Sql, me: string) {
    this.#sql = sql;
    this.#me = me;
  }

  /**
   * Takes the next ticket into Plan, if nothing is in Plan or waiting for Build: the oldest open ticket of the
   * highest severity that has never been on the line. Returns its work item, or undefined.
   */
  async admit(): Promise<string | undefined> {
    return this.#sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('line'))`;
      const [busy] = await tx`select 1 from line where stage in ('plan', 'build') limit 1`;
      if (busy) return undefined;
      const [taken] = await tx<{ work_item: string }[]>`
        insert into line (work_item, stage)
        select t.work_item, 'plan' from events t
        where t.type = 'ticket.opened' and not t.sample
          and not exists (select 1 from events c where c.work_item = t.work_item and c.type = 'work-item.closed')
          and not exists (select 1 from line l where l.work_item = t.work_item)
        order by case t.payload->>'severity' when 'broken' then 3 when 'degraded' then 2 else 1 end desc, t.seq
        limit 1
        returning work_item`;
      return taken?.work_item;
    }) as Promise<string | undefined>;
  }

  /** The work items on the line that nobody holds, longest on it first. */
  async free(): Promise<QueueItem[]> {
    const rows = await this.#sql<Row[]>`
      select ${this.#sql(COLUMNS)} from line
      where stage <> 'ended' and (held_until is null or held_until < clock_timestamp())
      order by taken_at`;
    return rows.map(item);
  }

  /**
   * Holds a work item for this worker for a while, so no other acts on it meanwhile. Undefined if another holds it,
   * or it has ended. A step's lease outlasts the step's deadline; a crash leaves it to run out.
   */
  async claim(workItem: string, seconds: number): Promise<QueueItem | undefined> {
    const [row] = await this.#sql<Row[]>`
      update line set held_by = ${this.#me}, held_until = clock_timestamp() + make_interval(secs => ${seconds})
      where work_item = ${workItem} and stage <> 'ended'
        and (held_until is null or held_until < clock_timestamp() or held_by = ${this.#me})
      returning ${this.#sql(COLUMNS)}`;
    return row && item(row);
  }

  /** A work item on the line, ended or not. */
  async get(workItem: string): Promise<QueueItem | undefined> {
    const [row] = await this.#sql<Row[]>`
      select ${this.#sql(COLUMNS)} from line where work_item = ${workItem}`;
    return row && item(row);
  }

  /** Records where a work item this worker holds now is, keeping hold of it. */
  async move(workItem: string, stage: QueueStage): Promise<void> {
    await this.#sql`
      update line set stage = ${stage}, moved_at = case when stage = ${stage} then moved_at else clock_timestamp() end
      where work_item = ${workItem} and held_by = ${this.#me}`;
  }

  /** Lets go of a work item, recording where it now is. */
  async release(workItem: string, stage: QueueStage): Promise<void> {
    await this.#sql`
      update line set held_by = null, held_until = null, stage = ${stage},
                      moved_at = case when stage = ${stage} then moved_at else clock_timestamp() end
      where work_item = ${workItem} and held_by = ${this.#me}`;
  }

  /** Counts a step started, and returns its number within the work item: it names the step's job. */
  async startStep(workItem: string): Promise<number> {
    const [row] = await this.#sql<{ steps: number }[]>`
      update line set steps = steps + 1 where work_item = ${workItem} returning steps`;
    if (!row) throw new Error(`Work item ${workItem} is not on the line.`);
    return row.steps;
  }

  /** Counts a failed attempt at the step in hand, with why: its handback, if one was kept, is over. */
  async failed(workItem: string, reason: string): Promise<void> {
    await this.#sql`update line set failures = failures + 1, failure = ${reason.slice(0, 500)}, effects = null
                    where work_item = ${workItem}`;
  }

  /** The work item moved on: its step in hand has not failed yet, and no handback waits for its effects. */
  async moved(workItem: string): Promise<void> {
    await this.#sql`update line set failures = 0, failure = null, effects = null where work_item = ${workItem}`;
  }

  /** Keeps a handback until its effects are done. */
  async keep(workItem: string, pending: Pending): Promise<void> {
    await this.#sql`update line set effects = ${this.#sql.json(pending as unknown as JSONValue)}
                    where work_item = ${workItem}`;
  }

  /** Lets go of a handback whose effects will not be tried again. */
  async drop(workItem: string): Promise<void> {
    await this.#sql`update line set effects = null where work_item = ${workItem}`;
  }

  /** Records that one of a kept handback's writes has begun, before it is made. */
  async begun(workItem: string, name: string): Promise<void> {
    await this.#sql`
      update line set effects = jsonb_set(effects, '{begun}', (effects->'begun') || to_jsonb(${name}::text))
      where work_item = ${workItem} and effects is not null`;
  }

  /** Records what one of a kept handback's writes gave back, once it is made. */
  async done(workItem: string, name: string, result: JSONValue): Promise<void> {
    await this.#sql`
      update line set effects = jsonb_set(effects, array['done', ${name}::text], ${this.#sql.json(result)})
      where work_item = ${workItem} and effects is not null`;
  }

  /** Counts a failed try at a kept handback's effects, with why and when to try again. */
  async effectsFailed(workItem: string, reason: string, retryAt: Date): Promise<void> {
    await this.#sql`
      update line set effects = effects || jsonb_build_object(
        'tries', (effects->>'tries')::int + 1, 'failure', ${reason.slice(0, 500)}::text,
        'retryAt', ${retryAt.toISOString()}::text)
      where work_item = ${workItem} and effects is not null`;
  }

  async setIssue(workItem: string, issue: number): Promise<void> {
    await this.#sql`update line set issue = ${issue} where work_item = ${workItem}`;
  }

  async setSession(workItem: string, session: string | null): Promise<void> {
    await this.#sql`update line set session = ${session} where work_item = ${workItem}`;
  }

  /** Lets go of everything this worker holds, as it stops. */
  async releaseAll(): Promise<void> {
    await this.#sql`update line set held_by = null, held_until = null where held_by = ${this.#me}`;
  }
}
