/**
 * Counting spend against the caps in `policy/spend.ts`, from the `model_calls` table, so it survives a restart.
 *
 * A window is a UTC day or a UTC calendar month. Before a provider call, `check` refuses when the day's, the
 * month's or the work item's spend has reached its cap. The check and the call are not one step, so calls already
 * in flight when a cap is reached finish and may take the total a little past it.
 *
 * The line hears of a day or month cap too: `spend.capped` is appended once when one is reached, and
 * `spend.cleared` when it no longer is (the window moved on, or the policy was raised). Which caps are marked is
 * read from the store at start, so a restart neither repeats nor forgets. A work item's cap writes no line event:
 * the caller deals with it.
 */
import type { NewEvent } from '@software-factory/events';
import type { EventWriter } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import type { Profile, SpendPolicy } from '../../../../policy/spend.ts';
import { SpendCapped } from './errors.ts';

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
  policy: SpendPolicy;
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
  readonly #policy: SpendPolicy;
  readonly #log: Logger;
  readonly #clock: () => Date;
  readonly #marked = new Set<Cap>();
  #queue: Promise<void> = Promise.resolve();
  #timer: NodeJS.Timeout | undefined;

  constructor({ sql, events, profile, policy, log, clock = () => new Date() }: SpendOptions) {
    this.#sql = sql;
    this.#events = events;
    this.#profile = profile;
    this.#policy = policy;
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
    const reached = await this.#reached();
    if (reached.length) {
      await this.reconcile();
      throw reached.at(-1) as SpendCapped;
    }
    if (workItem !== null) {
      const spent = await this.#workItem(workItem);
      if (spent >= this.#policy.workItemUsd) throw new SpendCapped('work-item', this.#policy.workItemUsd, spent, null);
    }
  }

  /** The day and month caps now reached, the day's first. */
  async #reached(): Promise<SpendCapped[]> {
    const totals = await this.#totals();
    const { day, month } = windowsAt(this.#clock());
    const reached: SpendCapped[] = [];
    if (totals.day >= this.#policy.dayUsd) {
      reached.push(new SpendCapped('day', this.#policy.dayUsd, totals.day, day.end.toISOString()));
    }
    if (this.#policy.monthUsd !== null && totals.month >= this.#policy.monthUsd) {
      reached.push(new SpendCapped('month', this.#policy.monthUsd, totals.month, month.end.toISOString()));
    }
    return reached;
  }

  async report(): Promise<SpendReport> {
    const totals = await this.#totals();
    const { day, month } = windowsAt(this.#clock());
    return {
      profile: this.#profile,
      day: { spentUsd: totals.day, limitUsd: this.#policy.dayUsd, resets: day.end.toISOString() },
      month: { spentUsd: totals.month, limitUsd: this.#policy.monthUsd, resets: month.end.toISOString() },
      workItemLimitUsd: this.#policy.workItemUsd,
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
        this.#log.error(
          { err: { type: (error as Error).name, message: (error as Error).message } },
          'could not update the line on spend caps',
        );
      });
    return this.#queue;
  }

  async #reconcile(): Promise<void> {
    const reached = new Map((await this.#reached()).map((cap) => [cap.cap as Cap, cap]));
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

  /** Looks for a window that has reset about once a minute, so the line hears that calls can resume. */
  start(everyMs = 60_000): void {
    this.#timer = setInterval(() => void this.reconcile(), everyMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    await this.#queue;
  }
}
