/**
 * The scoreboard's pass: read the tickets' lives from the store, count them against the key, and append
 * `score.updated` when what it would publish differs from the last it published. It keeps nothing between passes:
 * the last figures are the store's, so a restart publishes nothing new. With no key, it publishes once that it is off.
 *
 * It acts only on a store of real events: samples are not the factory's work, and a real event in a sample store
 * would be refused.
 */
import { type NewEvent, type PayloadOf, upcast, VERSIONS } from '@software-factory/events';
import { type EventWriter, openedAsImprovement, storeKind } from '@software-factory/store';
import type { Sql } from 'postgres';
import type { KeyEntry } from '../../../../policy/scoreboard.ts';
import { figures, lastBoundary, SCORE_TYPES, type ScoreEvent, tickets } from './figures.ts';

export type Score = PayloadOf<'score.updated'>;

/** What a pass did. */
export type Pass = 'published' | 'unchanged' | 'not-real';

export interface ScoreboardOptions {
  sql: Sql;
  events: EventWriter;
  /** The answer key, or null when there is none. */
  key: readonly KeyEntry[] | null;
  now?: () => Date;
}

export class Scoreboard {
  readonly #sql: Sql;
  readonly #events: EventWriter;
  readonly #key: readonly KeyEntry[] | null;
  readonly #now: () => Date;

  constructor({ sql, events, key, now = () => new Date() }: ScoreboardOptions) {
    this.#sql = sql;
    this.#events = events;
    this.#key = key;
    this.#now = now;
  }

  /** Publishes the figures if they changed since the last `score.updated`. */
  async pass(): Promise<{ pass: Pass; score?: Score }> {
    if ((await storeKind(this.#sql)) !== 'real') return { pass: 'not-real' };
    const now = this.#now();
    const score = this.#key ? await this.#figures(now) : ({ keyed: false } as const);
    if (same(score, await this.#last())) return { pass: 'unchanged', score };
    await this.#events.append(scoreEvent(score, now));
    return { pass: 'published', score };
  }

  /** The figures as published: found on the cadence, and no false positives. */
  async #figures(now: Date): Promise<Score> {
    const { falsePositives: _, ...published } = figures(
      tickets(await readScoreEvents(this.#sql)),
      this.#key ?? [],
      lastBoundary(now.getTime()),
    );
    return { keyed: true, ...published };
  }

  async #last(): Promise<Score | null> {
    const [row] = await this.#sql<{ type: string; version: number; payload: unknown }[]>`
      select type, version, payload from events where type = 'score.updated' order by seq desc limit 1`;
    if (!row) return null;
    const read = upcast(row);
    if (!read.ok) throw new Error(`The last score.updated is version ${row.version}, newer than this scoreboard's`);
    return read.event.payload as Score;
  }
}

/** The events the figures read, in the store's order, each upcast to its current version. */
export async function readScoreEvents(sql: Sql): Promise<ScoreEvent[]> {
  // A signal's payload is never needed, only when it came: a report's words are not read at all.
  const rows = await sql<
    { ts: Date; work_item: string; type: ScoreEvent['type']; version: number; payload: unknown }[]
  >`
    select ts, work_item, type, version,
           case when type = 'signal.received' then '{}'::jsonb else payload end as payload
    from events e where type in ${sql(SCORE_TYPES)} and work_item is not null
      -- A work item opened as an improvement has no ticket, whatever is appended to it.
      and not (e.type = 'ticket.opened' and ${openedAsImprovement(sql, 'e.work_item')})
    order by seq`;
  return rows.map((row) => {
    if (row.type === 'signal.received') return { ts: row.ts.toISOString(), work_item: row.work_item, type: row.type };
    const read = upcast(row);
    if (!read.ok) throw new Error(`A ${row.type} event is version ${row.version}, newer than this scoreboard's`);
    return {
      ts: row.ts.toISOString(),
      work_item: row.work_item,
      type: row.type,
      payload: read.event.payload,
    } as ScoreEvent;
  });
}

function scoreEvent(score: Score, now: Date): NewEvent<'score.updated'> {
  const summary = score.keyed
    ? `The scoreboard: ${score.found} of ${score.entries} found, ${score.verified} verified fixed`
    : 'The scoreboard is off: it has no answer key';
  return {
    id: crypto.randomUUID(),
    ts: now.toISOString(),
    work_item: null,
    type: 'score.updated',
    version: VERSIONS['score.updated'],
    actor: 'scoreboard',
    summary,
    payload: score,
    artifacts: [],
  };
}

const same = (a: Score, b: Score | null) =>
  b !== null &&
  (a.keyed && b.keyed
    ? a.entries === b.entries && a.found === b.found && a.verified === b.verified && a.medianMs === b.medianMs
    : a.keyed === b.keyed);
