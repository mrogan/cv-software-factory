/**
 * Verify by variant (milestone 7, task 17): the line's pass over the feature flags, judging each improvement's work
 * item at the stage Martin set its flag at. It is driven by the flags' state, as the admin service records Martin's
 * moves (`flag.staged`) and the line's own judgements of them, never by the ticket machine (`machine.ts`): the line's
 * queue takes tickets, and an improvement is not on it. So it runs as a pass of its own, beside the release watch,
 * about every thirty seconds while the line runs, in every mode (a flag is real in a dry run too), and takes no lease:
 * it appends only what the flags' events call for, which the next pass reads.
 *
 * - **Read from the store** (`flagEvents`, the reader the admin service judges a move by): Martin's moves from his
 *   roles alone, the line's comparisons, and which improvement's spec names each flag; and, for each work item a flag
 *   was last staged on, whether it is an improvement of the factory's own (not a sample) and still open.
 * - **Decided here, purely** (`flagsNext`): given that, what the pass does for each flag. Today one thing: a flag
 *   Martin turned off, at any stage, closes the improvement it was staged on as turned off, with his reason. It is no
 *   rollback: the code stays in the app, off. Closed once, as the work item is then closed; a flag turned back on from
 *   Everyone after it closed stays on, on a closed work item, and turning it off again closes nothing more.
 * - **With just one** (`only`), it acts on that work item alone.
 */
import type { EventWriter, FlagEvents } from '@software-factory/store';
import { flagEvents, lastEnd } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { flagsFrom, stageWords } from '../../../../policy/flag-moves.ts';
import type { Stage } from '../../../../policy/flags.ts';
import { asEvent } from './gates.ts';
import { countRecorded } from './metrics.ts';

/** A work item a flag was last staged on, as the pass needs it. */
export interface FlagItem {
  improvement: boolean;
  sample: boolean;
  closed: boolean;
}

/** What the pass decides from. */
export interface FlagFacts {
  /** The flags' events, as the store tells them. */
  flags: FlagEvents;
  /** Each work item a flag was last staged on (`itemsAsked`), by number: one the store has no opening of is missing. */
  items: Readonly<Record<string, FlagItem>>;
  /** The one work item the line acts on, or null for every one. */
  only: string | null;
}

/** What the pass does for a flag. */
export type FlagNext = {
  do: 'close';
  flag: string;
  workItem: string;
  /** The stage it was turned off from. */
  from: Stage | null;
  /** Martin's reason, from his move. */
  reason: string;
};

/** The reason a close gives when Martin's move gave none, which no `flag.staged` to Off can. */
const NO_REASON = 'Martin turned its flag off';

/** The work items the pass needs to know about: each one a flag was last staged on. */
export function itemsAsked(flags: FlagEvents): string[] {
  const told = flagsFrom(flags.records, flags.named);
  return [...new Set(Object.values(told).flatMap((now) => (now.stagedOn ? [now.stagedOn] : [])))];
}

/** What the pass does for each flag, given the flags' state: a pure function, so a test drives it with records. */
export function flagsNext({ flags, items, only }: FlagFacts): FlagNext[] {
  const told = flagsFrom(flags.records, flags.named);
  const next: FlagNext[] = [];
  for (const [flag, now] of Object.entries(told)) {
    const workItem = now.stagedOn;
    if (!workItem || (only !== null && workItem !== only)) continue;
    const item = items[workItem];
    if (!item?.improvement || item.sample || item.closed) continue;
    // Turned off, at any stage: Martin's last move went to Off, on this work item.
    if (now.last?.to.stage === 'off') {
      const move = flags.records.findLast((r) => r.type === 'flag.staged' && r.flag === flag);
      const reason = (move?.type === 'flag.staged' && move.reason) || NO_REASON;
      next.push({ do: 'close', flag, workItem, from: now.last.from, reason });
    }
  }
  return next;
}

export interface FlagPassOptions {
  /** As the line's role. */
  sql: Sql;
  events: Pick<EventWriter, 'append'>;
  log: Logger;
  now: () => Date;
}

/** The pass: reads the flags' state, decides, and appends what it decided. */
export class FlagPass {
  readonly #o: FlagPassOptions;

  constructor(options: FlagPassOptions) {
    this.#o = options;
  }

  async pass(only: string | null): Promise<void> {
    const flags = await flagEvents(this.#o.sql);
    const asked = itemsAsked(flags);
    if (!asked.length) return;
    const items = await this.#items(asked);
    for (const next of flagsNext({ flags, items, only })) {
      const ts = this.#o.now().toISOString();
      const drafts = [
        {
          type: 'work-item.closed' as const,
          actor: 'factory' as const,
          summary: `Closed: Martin turned ${next.flag} off, from ${stageWords(next.from)}`,
          payload: { outcome: 'turned-off' as const, reason: next.reason },
        },
      ];
      await this.#o.events.append(drafts.map((draft) => asEvent(next.workItem, draft, ts)));
      countRecorded(drafts);
      this.#o.log.info({ workItem: next.workItem, flag: next.flag }, 'closed an improvement whose flag was turned off');
    }
  }

  async #items(workItems: string[]): Promise<Record<string, FlagItem>> {
    const sql = this.#o.sql;
    const rows = await sql<{ work_item: string; kind: string; sample: boolean; closed: boolean }[]>`
      select o.work_item, o.payload->>'kind' as kind, o.sample,
             ${lastEnd(sql, 'o.work_item')} is not distinct from 'work-item.closed' as closed
      from events o where o.type = 'work-item.opened' and o.work_item = any(${workItems})`;
    return Object.fromEntries(
      rows.map((row) => [
        row.work_item,
        { improvement: row.kind === 'improvement', sample: row.sample, closed: row.closed },
      ]),
    );
  }
}
