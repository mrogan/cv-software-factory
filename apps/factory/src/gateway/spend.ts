/**
 * Counting spend against the caps in force (Martin's settings within `policy/spend.ts`, or its defaults), from the
 * `model_calls` table, so it survives a restart. The caps are read again at each check, so one Martin changes applies
 * from the next call.
 *
 * A window is a UTC day or a UTC calendar month. Before a provider call, `check` refuses when the day's, the
 * month's or the work item's spend has reached its cap. The check and the call are not one step, so calls already
 * in flight when a cap is reached finish and may take the total a little past it.
 *
 * The line hears of a day or month cap too: `spend.capped` is appended once when one is reached, and
 * `spend.cleared` when it no longer is (the window moved on, or the cap was raised). Which caps are marked is
 * read from the store at start, so a restart neither repeats nor forgets. A work item's cap writes no line event:
 * the caller deals with it.
 */
import type { NewEvent } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { Profile, SpendPolicy } from '../../../../policy/spend.ts';
import { SpendCapped } from './errors.ts';
import { observeCaps } from './metrics.ts';

type Cap = 'day' | 'month';

export interface SpendWindow {
  spentUsd: number;
  limitUsd: number | null;
  /** When the window ends and its spend starts again from nothing. */
  resets: string;
}

export interface SpendReport {
  profile: Profile;
  day: SpendWindow;
  month: SpendWindow;
  workItemLimitUsd: number;
  /** The day and month caps the line has been told are reached. */
  capped: Cap[];
}

export interface SpendOptions {
  sql: Sql;
  events: EventWriter;
  profile: Profile;
  /**
   * The caps: fixed, or read as they are in force at each check, from a cache of a few seconds, or `fresh` from the
   * store before a call is refused, so a cap raised a moment ago never refuses a call.
   */
  policy: SpendPolicy | ((fresh: boolean) => Promise<SpendPolicy>);
  log: Logger;
  clock?: () => Date;
}

/** The start of the UTC day and month containing `now`, and when each ends. */
export function windowsAt(now: Date) {
  const [year, month, day] = [now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()];
  return {
    day: { start: new Date(Date.UTC(year, month, day)), end: new Date(Date.UTC(year, month, day + 1)) },
    month: { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) },
  };
}

export class Spend {
  readonly #sql: Sql;
  readonly #events: EventWriter;
  readonly #profile: Profile;
  readonly #policy: (fresh: boolean) => Promise<SpendPolicy>;
  readonly #log: Logger;
  readonly #clock: () => Date;
  readonly #marked = new Set<Cap>();
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;
  /** The day's and month's spend as the last reconcile counted it, for the metrics: a minute old at most once started. */
  #counted: { day: number; month: number; caps: SpendPolicy } | undefined;
  #unobserve: (() => void) | undefined;

  constructor({ sql, events, profile, policy, log, clock = () => new Date() }: SpendOptions) {
    this.#sql = sql;
    this.#events = events;
    this.#profile = profile;
    this.#policy = typeof policy === 'function' ? policy : async () => policy;
    this.#log = log;
    this.#clock = clock;
  }

  /** Spend in the current day and month. */
  async #totals(): Promise<{ day: number; month: number }> {
    const { day, month } = windowsAt(this.#clock());
    const [row] = await this.#sql<{ day: number; month: number }[]>`
      select coalesce(sum(cost_usd) filter (where at >= ${day.start.toISOString()}::timestamptz), 0)::float8 as day,
             coalesce(sum(cost_usd), 0)::float8 as month
      from model_calls
      where at >= ${month.start.toISOString()}::timestamptz and at < ${month.end.toISOString()}::timestamptz`;
    return row ?? { day: 0, month: 0 };
  }

  async #workItem(workItem: string): Promise<number> {
    const [row] = await this.#sql<{ spent: number }[]>`
      select coalesce(sum(cost_usd), 0)::float8 as spent from model_calls where work_item = ${workItem}`;
    return row?.spent ?? 0;
  }

  /** Throws `SpendCapped` for the cap that is reached: the month's before the day's, which resets sooner. */
  async check(workItem: string | null): Promise<void> {
    const refusal = await this.#refusal(await this.#policy(false), workItem);
    // Refused by the caps as read a moment ago: read them again, so a cap Martin has just raised refuses nothing.
    const final = refusal && (await this.#refusal(await this.#policy(true), workItem));
    // A cap marked and no longer reached (raised, or its window over) is cleared at once, not at the next tick.
    if (final || this.#marked.size) await this.reconcile();
    if (final) throw final;
  }

  /** The cap that refuses a call now, if any: the month's before the day's, then the work item's. */
  async #refusal(caps: SpendPolicy, workItem: string | null): Promise<SpendCapped | undefined> {
    const reached = await this.#reached(caps);
    if (reached.length) return reached.at(-1);
    if (workItem === null) return undefined;
    const spent = await this.#workItem(workItem);
    return spent >= caps.workItemUsd ? new SpendCapped('work-item', caps.workItemUsd, spent, null) : undefined;
  }

  /** The day and month caps now reached, the day's first. */
  async #reached(caps: SpendPolicy, totals?: { day: number; month: number }): Promise<SpendCapped[]> {
    totals ??= await this.#totals();
    const { day, month } = windowsAt(this.#clock());
    const reached: SpendCapped[] = [];
    if (totals.day >= caps.dayUsd) {
      reached.push(new SpendCapped('day', caps.dayUsd, totals.day, day.end.toISOString()));
    }
    if (caps.monthUsd !== null && totals.month >= caps.monthUsd) {
      reached.push(new SpendCapped('month', caps.monthUsd, totals.month, month.end.toISOString()));
    }
    return reached;
  }

  async report(): Promise<SpendReport> {
    const [caps, totals] = await Promise.all([this.#policy(false), this.#totals()]);
    const { day, month } = windowsAt(this.#clock());
    return {
      profile: this.#profile,
      day: { spentUsd: totals.day, limitUsd: caps.dayUsd, resets: day.end.toISOString() },
      month: { spentUsd: totals.month, limitUsd: caps.monthUsd, resets: month.end.toISOString() },
      workItemLimitUsd: caps.workItemUsd,
      capped: [...this.#marked],
    };
  }

  /**
   * Brings the line's idea of the caps in line with the spend: appends `spend.capped` for a cap reached and not
   * yet marked, and `spend.cleared` for one marked and no longer reached. One at a time, so two calls reaching a
   * cap together append it once. A failure is logged and tried again on the next call or tick.
   */
  reconcile(): Promise<void> {
    this.#queue = this.#queue
      .then(() => this.#reconcile())
      .catch((error: unknown) => {
        this.#log.error({ err: error }, 'could not update the line on spend caps');
      });
    return this.#queue;
  }

  async #reconcile(): Promise<void> {
    // Counted here alone, one reconcile at a time, so the metrics never go back to an older count.
    // The line hears of a cap only as it is in force this moment, never a cache's.
    const [caps, totals] = await Promise.all([this.#policy(true), this.#totals()]);
    this.#counted = { ...totals, caps };
    const reached = new Map((await this.#reached(caps, totals)).map((cap) => [cap.cap as Cap, cap]));
    for (const [cap, refusal] of reached) {
      if (this.#marked.has(cap)) continue;
      const event: NewEvent<'spend.capped'> = {
        ...this.#envelope(),
        type: 'spend.capped',
        summary: `Model spend reached the ${cap} cap of $${refusal.limitUsd.toFixed(2)}; calls wait until ${refusal.resets}`,
        payload: { cap, limitUsd: refusal.limitUsd, spentUsd: refusal.spentUsd, resets: refusal.resets as string },
      };
      await this.#events.append(event);
      this.#marked.add(cap);
      this.#log.warn(
        { cap, limitUsd: refusal.limitUsd, spentUsd: refusal.spentUsd, resets: refusal.resets },
        'spend cap reached',
      );
    }
    for (const cap of [...this.#marked]) {
      if (reached.has(cap)) continue;
      const event: NewEvent<'spend.cleared'> = {
        ...this.#envelope(),
        type: 'spend.cleared',
        summary: `Model spend is under the ${cap} cap again; calls resume`,
        payload: { cap },
      };
      await this.#events.append(event);
      this.#marked.delete(cap);
      this.#log.info({ cap }, 'spend cap cleared');
    }
  }

  #envelope() {
    return {
      id: crypto.randomUUID(),
      ts: this.#clock().toISOString(),
      work_item: null,
      version: 2 as const,
      actor: 'factory' as const,
      artifacts: [],
    };
  }

  /**
   * Reads which day and month caps the store last marked, so a restart carries on from there. Then reconciles. A
   * provider's cap is `ProviderCaps`' to resume and clear.
   */
  async resume(): Promise<void> {
    const rows = await this.#sql<{ cap: Cap; type: string }[]>`
      select distinct on (payload->>'cap') payload->>'cap' as cap, type
      from events where type in ('spend.capped', 'spend.cleared') and payload->>'cap' in ('day', 'month')
      order by payload->>'cap', seq desc`;
    this.#marked.clear();
    for (const row of rows) if (row.type === 'spend.capped') this.#marked.add(row.cap);
    await this.reconcile();
  }

  /**
   * Looks for a window that has reset about once a minute, so the line hears that calls can resume, and reports the
   * spend against the caps as it last counted it.
   */
  start(everyMs = 60_000): void {
    this.#timer = setInterval(() => void this.reconcile(), everyMs);
    this.#timer.unref();
    this.#unobserve ??= observeCaps(() =>
      this.#counted
        ? {
            profile: this.#profile,
            dayUsd: this.#counted.day,
            monthUsd: this.#counted.month,
            limits: { ...this.#counted.caps },
          }
        : undefined,
    );
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#unobserve?.();
    this.#unobserve = undefined;
    await this.#queue;
  }
}
