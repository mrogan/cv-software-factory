/**
 * Verify by variant (milestone 7, task 17): the line's pass over the feature flags, judging each improvement's work
 * item at the stage Martin set its flag at. It is driven by the flags' state, as the admin service records Martin's
 * moves (`flag.staged`) and the line's own judgements of them, never by the ticket machine (`machine.ts`): the line's
 * queue takes tickets, and an improvement is not on it. So it runs as a pass of its own, beside the release watch,
 * about every thirty seconds while the line runs, live and in a dry run (a flag is real there too), and takes no lease:
 * it appends only what the flags' events call for, which the next pass reads.
 *
 * - **Read from the store** (`flagEvents`, the reader the admin service judges a move by): Martin's moves from his
 *   roles alone, the line's comparisons, and which improvement's spec names each flag; and, for each work item a flag
 *   was last staged on, whether it is an improvement of the factory's own (not a sample) and still open.
 * - **Decided here, purely** (`flagsNext`): given that, what the pass does for each flag.
 *   - **Turned off**: a flag Martin turned off, at any stage, closes the improvement it was staged on as turned off,
 *     with his reason. It is no rollback: the code stays in the app, off. Closed once, as the work item is then closed;
 *     a flag turned back on from Everyone after it closed stays on, on a closed work item, and turning it off again
 *     closes nothing more.
 *   - **At Share**: a flag Martin set at the share stage has its two sides compared on the traffic generator's own
 *     requests (`compare.ts`), from a minute after his move, the time the app has to hold it (`FLAGS_HELD`), less every
 *     canary's time in flight, as the line recorded its releases, padded by how often it reads them. Until the window is
 *     long enough and each side has enough requests, it waits and appends nothing; then it appends `flag.compared`,
 *     passed or failed, once for that move. Everyone waits on it (`policy/flag-moves.ts`). Without Prometheus
 *     (`PROMETHEUS_URL`, Verify's), it waits.
 *   - **Checked with the probes** (`flag-checks.ts`): while an open improvement's flag is at Off, the probes take a
 *     baseline of the stable version, once for each version and flag set it runs with: the journeys and the `/device` check, and
 *     pictures of the spec's pages, all with the flag off, since every probe request carries the mark, which the flag
 *     is on for from Checks. At Checks and at Preview, the same again, compared with the latest baseline, once for each
 *     of Martin's moves there; at Preview a probe first asks to preview the flag. Each is asked once a pass, and the
 *     probes join the run already going; each run checks the app held the flag set Martin's latest move wrote, before
 *     and after, or it is tried again on the next pass. Then it appends `flag.checked`. Without the probes
 *     (`PROBES_URL`, Verify's), it waits.
 * - **With just one** (`only`), it acts on that work item alone.
 */
import type { EventWriter, FlagEvents, StoredFlagCheck } from '@software-factory/store';
import { flagEvents, lastEnd } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { flagsFrom, stageWords } from '../../../../policy/flag-moves.ts';
import { FLAGS_HELD, type Share, type Stage } from '../../../../policy/flags.ts';
import { release as RELEASE } from '../../../../policy/release.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import { figuresOf, figuresQuery, judge, type Sides, type Span, sidesOf, windowOf } from './compare.ts';
import { type CheckAsked, checkedDraft, FRONT_PAGE, requestOf } from './flag-checks.ts';
import { asEvent } from './gates.ts';
import { countRecorded } from './metrics.ts';
import type { FlagChecksPort } from './verify.ts';

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
export type FlagNext =
  | {
      do: 'close';
      flag: string;
      workItem: string;
      /** The stage it was turned off from. */
      from: Stage | null;
      /** Martin's reason, from his move. */
      reason: string;
    }
  | {
      do: 'compare';
      flag: string;
      workItem: string;
      share: Share;
      /** Martin's move to this share: its place in the store, and when it was made. */
      move: { seq: string; ts: string };
    }
  | ({ do: 'check' } & CheckAsked);

/** The reason a close gives when Martin's move gave none, which no `flag.staged` to Off can. */
const NO_REASON = 'Martin turned its flag off';

/**
 * The work items the pass needs to know about: each one a flag was last staged on, and each improvement whose spec
 * names a flag at Off, whose baseline the probes take.
 */
export function itemsAsked(flags: FlagEvents): string[] {
  const told = flagsFrom(flags.records, flags.named);
  return [
    ...new Set(
      Object.values(told).flatMap((now) => [
        ...(now.stagedOn ? [now.stagedOn] : []),
        ...(now.stage?.stage === 'off' && now.workItem ? [now.workItem] : []),
      ]),
    ),
  ];
}

/** Whether one place in the store comes after another. */
const after = (seq: string, than: string) => BigInt(seq) > BigInt(than);

/** What the pass does for each flag, given the flags' state: a pure function, so a test drives it with records. */
export function flagsNext({ flags, items, only }: FlagFacts): FlagNext[] {
  const told = flagsFrom(flags.records, flags.named);
  const next: FlagNext[] = [];
  const revision = flags.revision ?? 'none';
  for (const [flag, now] of Object.entries(told)) {
    const move = flags.records.findLast((r) => r.type === 'flag.staged' && r.flag === flag);
    const checks = flags.checked.filter((c) => c.check.flag === flag);
    /** The latest baseline taken for an improvement: another's, which reused the flag's name, is none of its. */
    const baselineOf = (item: string) => checks.findLast((c) => c.check.stage === 'off' && c.workItem === item) ?? null;
    // At Off, on an open improvement whose spec names it: the baseline, once for each version the app runs, which the
    // probes tell (`have`). Never staged on it: one staged on an earlier improvement may be named again by this one's
    // spec, and one turned off on this one closes it.
    const named = now.workItem;
    const improvement = named ? items[named] : undefined;
    const taken = named ? baselineOf(named) : null;
    if (
      now.stage?.stage === 'off' &&
      named &&
      now.stagedOn !== named &&
      (only === null || named === only) &&
      improvement?.improvement &&
      !improvement.sample &&
      !improvement.closed
    ) {
      next.push({
        do: 'check',
        flag,
        workItem: named,
        stage: 'off',
        revision,
        move: move?.seq ?? null,
        // Taken again for a new flag set too: another flag moved meanwhile changes what the probes see.
        ...(taken?.check.revision === revision && { have: taken.check.version }),
        base: null,
        pages: FRONT_PAGE,
      });
    }
    const workItem = now.stagedOn;
    if (!workItem || (only !== null && workItem !== only)) continue;
    const item = items[workItem];
    if (!item?.improvement || item.sample) continue;
    // Turned off, at any stage: Martin's last move went to Off, on this work item. It closes once, whichever of its
    // flags was turned off.
    if (
      now.last?.to.stage === 'off' &&
      !item.closed &&
      !next.some((n) => n.do === 'close' && n.workItem === workItem)
    ) {
      const reason = (move?.type === 'flag.staged' && move.reason) || NO_REASON;
      next.push({ do: 'close', flag, workItem, from: now.last.from, reason });
    }
    // At Share, and not yet compared since Martin's move there: a move clears the comparison before it. On a closed
    // work item too: a flag turned off from Everyone may go back on, be narrowed to Share and wait on a comparison.
    if (now.last?.to.stage === 'share' && !now.compared && move) {
      next.push({ do: 'compare', flag, workItem, share: now.last.to.share, move: { seq: move.seq, ts: move.ts } });
    }
    // At Checks or Preview, and not yet checked there since Martin's move: once for each move, against the latest
    // baseline taken for this improvement, whichever version it was taken of.
    const stage = now.last?.to.stage;
    if ((stage === 'checks' || stage === 'preview') && move && !checkedSince(checks, stage, move.seq)) {
      const base = baselineOf(workItem);
      next.push({ do: 'check', flag, workItem, stage, revision, move: move.seq, base, pages: FRONT_PAGE });
    }
  }
  return next;
}

/** Whether a flag was checked at a stage since a move. */
const checkedSince = (checks: readonly StoredFlagCheck[], stage: 'checks' | 'preview', move: string) =>
  checks.some((c) => c.check.stage === stage && after(c.seq, move));

export interface FlagPassOptions {
  /** As the line's role. */
  sql: Sql;
  events: Pick<EventWriter, 'append'>;
  log: Logger;
  now: () => Date;
  /** Verify's Prometheus, which holds the traffic generator's figures: without it, a flag at Share waits. */
  prometheus?: Prometheus | null;
  /** How often the line reads the app's releases, which records each up to that late: a canary's span is padded by it. */
  releaseEveryMs: number;
  /** Verify's probes, which check a flag at Off, Checks and Preview: without them, those checks wait. */
  probes?: FlagChecksPort | null;
}

/** The pass: reads the flags' state, decides, and appends what it decided. */
export class FlagPass {
  readonly #o: FlagPassOptions;
  readonly #sides = new Map<string, Sides>();

  constructor(options: FlagPassOptions) {
    this.#o = options;
  }

  async pass(only: string | null): Promise<void> {
    const flags = await flagEvents(this.#o.sql);
    const asked = itemsAsked(flags);
    if (!asked.length) return;
    const items = await this.#items(asked);
    for (const next of flagsNext({ flags, items, only })) {
      if (next.do === 'close') await this.#close(next);
      else if (next.do === 'check') {
        await this.#check(next).catch((error: unknown) =>
          this.#o.log.warn(
            { workItem: next.workItem, flag: next.flag, stage: next.stage, err: error },
            'could not check a flag with the probes',
          ),
        );
      } else {
        // One that Prometheus or the store fails waits for no other, and is tried again on the next pass.
        await this.#compare(next).catch((error: unknown) =>
          this.#o.log.warn(
            { workItem: next.workItem, flag: next.flag, err: error },
            'could not compare a flag at Share',
          ),
        );
      }
    }
  }

  async #close(next: Extract<FlagNext, { do: 'close' }>): Promise<void> {
    const ts = this.#o.now().toISOString();
    const drafts = [
      {
        type: 'work-item.closed' as const,
        actor: 'factory' as const,
        summary: `Closed: Martin turned ${next.flag} off, from ${stageWords(next.from)}`,
        payload: { outcome: 'turned-off' as const, reason: next.reason },
      },
    ];
    // One the store refuses (closed meanwhile) waits for no other.
    try {
      await this.#o.events.append(drafts.map((draft) => asEvent(next.workItem, draft, ts)));
    } catch (error) {
      this.#o.log.warn(
        { workItem: next.workItem, flag: next.flag, err: error },
        'could not close a turned-off improvement',
      );
      return;
    }
    countRecorded(drafts);
    this.#o.log.info({ workItem: next.workItem, flag: next.flag }, 'closed an improvement whose flag was turned off');
  }

  /**
   * Compares a flag's two sides at its share, if the window allows, and appends `flag.compared` once it is judged.
   */
  async #compare(next: Extract<FlagNext, { do: 'compare' }>): Promise<void> {
    const { flag, workItem, share } = next;
    const now = this.#o.now();
    const from = Date.parse(next.move.ts) + FLAGS_HELD.takeSeconds * 1000;
    const to = now.getTime();
    // Not long enough even with no canary: nothing to ask yet.
    if (to - from < RELEASE.flags.windowMinutes * 60_000) return;
    const prometheus = this.#o.prometheus;
    if (!prometheus) {
      this.#o.log.debug({ workItem, flag }, 'cannot compare a flag at Share without Prometheus (PROMETHEUS_URL)');
      return;
    }
    const pad = this.#o.releaseEveryMs;
    const canaries = (await this.#canaries(new Date(from - pad), now)).map(
      ({ started, ended }): Span => ({ from: started.getTime() - pad, to: (ended?.getTime() ?? to) + pad }),
    );
    const window = windowOf(from, to, canaries);
    const answers = await Promise.all(
      window.pieces.map((piece) =>
        prometheus.instant(figuresQuery((piece.to - piece.from) / 1000), new Date(piece.to)),
      ),
    );
    const { on, off } = figuresOf(answers.flat(), this.#sidesOf(flag, share));
    const judgement = judge(on, off, window.judgedMs);
    if (judgement.kind === 'wait') {
      this.#o.log.debug({ workItem, flag, why: judgement.why }, 'a flag at Share waits to be compared');
      return;
    }
    // Martin may have moved it while the figures were read: then this comparison is of a stage it no longer holds.
    const latest = (await flagEvents(this.#o.sql, flag)).records.findLast((r) => r.type === 'flag.staged');
    if (latest?.seq !== next.move.seq) return;
    const side = ({ requests, errorRate, p99Ms }: typeof on) => ({ requests, errorRate, p99Ms });
    const drafts = [
      {
        type: 'flag.compared' as const,
        actor: 'factory' as const,
        summary: `${flag} at Share ${share}%: flag on against off ${judgement.outcome}`,
        payload: {
          flag,
          share,
          window: { from: new Date(from).toISOString(), to: now.toISOString() },
          setAsideMinutes: Math.round(window.setAsideMs / 60_000),
          outcome: judgement.outcome,
          sides: { on: side(on), off: side(off) },
          ...(judgement.reason !== undefined && { reason: judgement.reason }),
        },
      },
    ];
    await this.#o.events.append(drafts.map((draft) => asEvent(workItem, draft, now.toISOString())));
    countRecorded(drafts);
    this.#o.log.info({ workItem, flag, share, outcome: judgement.outcome }, 'compared a flag’s two sides at Share');
  }

  /**
   * Asks the probes to check a flag at its stage, once a pass, and appends `flag.checked` once they have answered with
   * a run that saw the stage: while it runs, the next pass asks again and joins it.
   */
  async #check(next: Extract<FlagNext, { do: 'check' }>): Promise<void> {
    const { flag, workItem, stage } = next;
    const probes = this.#o.probes;
    if (!probes) {
      this.#o.log.debug({ workItem, flag, stage }, 'cannot check a flag without the probes (PROBES_URL)');
      return;
    }
    const answer = await probes.flagCheck(requestOf(next));
    if (!answer || answer.kind === 'have') return;
    if (answer.kind === 'not-held') {
      this.#o.log.info(
        { workItem, flag, stage, why: answer.message },
        'a flag’s check did not see its stage; again later',
      );
      return;
    }
    // Martin may have moved it while the probes ran: then this check is of a stage it no longer holds.
    const latest = (await flagEvents(this.#o.sql, flag)).records.findLast((r) => r.type === 'flag.staged');
    if ((latest?.seq ?? null) !== next.move) return;
    const drafts = [checkedDraft(next, answer)];
    const ts = this.#o.now().toISOString();
    await this.#o.events.append(drafts.map((draft) => asEvent(workItem, draft, ts)));
    countRecorded(drafts);
    this.#o.log.info({ workItem, flag, stage, version: answer.version }, 'checked a flag with the probes');
  }

  /** The sides of a flag at a share, which depend on nothing else: worked out once. */
  #sidesOf(flag: string, share: Share): Sides {
    const key = `${flag}@${share}`;
    const known = this.#sides.get(key);
    if (known) return known;
    const sides = sidesOf(flag, share);
    this.#sides.set(key, sides);
    return sides;
  }

  /**
   * Each canary in the line's record that was in flight at any time since `since`: from each start (a retry starts the
   * same release again) to the promotion, rollback, abort or error after it, or none while it is still in flight. A
   * release recorded on several work items starts on each, and its spans overlap. A dry run's shipped nothing, and one
   * found live (`watched: false`) was recorded started and promoted at once, with no canary: both are left out.
   */
  async #canaries(since: Date, now: Date): Promise<{ started: Date; ended: Date | null }[]> {
    const sql = this.#o.sql;
    return sql<{ started: Date; ended: Date | null }[]>`
      select s.ts as started, e.ended from events s
      left join lateral (
        select min(x.ts) as ended from events x
        where x.type in ('release.promoted', 'release.rolled-back', 'release.aborted', 'release.errored')
          and not x.sample and x.payload->>'release' = s.payload->>'release' and x.ts >= s.ts
      ) e on true
      where s.type = 'release.started' and not s.sample and s.ts <= ${now}
        and coalesce((s.payload->>'dryRun')::boolean, false) = false
        and coalesce((s.payload->>'watched')::boolean, true)
        and (e.ended is null or e.ended >= ${since})`;
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
