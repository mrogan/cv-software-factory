/**
 * Verify by variant (milestone 7, task 17): the line's pass over the feature flags, judging each improvement's work
 * item at the stage Martin set its flag at. It is driven by the flags' state, as the admin service records Martin's
 * moves (`flag.staged`) and the line's own judgements of them, never by the ticket machine (`machine.ts`): the machine
 * carries an improvement to its release, and hands it over (`hand-over`), and its flag is judged here from its spec
 * on. So it runs as a pass of its own, beside the release watch, about every thirty seconds while the line runs, live
 * and in a dry run (a flag is real there too), and takes no lease: it appends only what the flags' events call for,
 * which the next pass reads.
 *
 * - **Read from the store** (`flagEvents`, the reader the admin service judges a move by): Martin's moves from his
 *   roles alone, the line's comparisons, and which improvement's spec names each flag, and the pages it names; and,
 *   for each work item a flag was last staged on, whether it is an improvement Martin asked for (its opening and his
 *   request both appended by one of his roles, as `flagEvents` and the queue judge one), not a sample, and still
 *   open. Any other work item a flag was staged on is left out, and logged once.
 * - **Decided here, purely** (`flagsNext`): given that, what the pass does for each flag.
 *   - **Turned off**: a flag Martin turned off, at any stage, closes the improvement it was staged on as turned off,
 *     with his reason, and its issue as not planned, saying so (in a dry run, as the GitHub worker records one). It is
 *     no rollback: the code stays in the app, off. Closed once, as the work item is then closed;
 *     a flag turned back on from Everyone after it closed stays on, on a closed work item, and turning it off again
 *     closes nothing more.
 *   - **At Everyone**: a flag Martin widened to Everyone closes the improvement it was staged on as verified, and its
 *     issue as completed, saying it is on for everyone, once the app has had the minute to hold his move that a
 *     comparison at Share waits for too (`FLAGS_HELD`). Everyone is reached only once Verify's comparison at Share
 *     passed (`policy/flag-moves.ts`), so the close judges nothing of its own. The flag stays Martin's: the store
 *     takes its events on the closed improvement, and turning it off then closes nothing more, nor does turning it
 *     back on.
 *   - **At Share**: a flag Martin set at the share stage has its two sides compared on the traffic generator's own
 *     requests (`compare.ts`), from a minute after his move, the time the app has to hold it (`FLAGS_HELD`), less every
 *     canary's time in flight, as the line recorded its releases, padded by how often it reads them. Until the window is
 *     long enough and each side has enough requests, it waits and appends nothing; then it appends `flag.compared`,
 *     passed or failed, once for that move. Everyone waits on it (`policy/flag-moves.ts`). Without Prometheus
 *     (`PROMETHEUS_URL`, Verify's), it waits.
 *   - **Checked with the probes** (`flag-checks.ts`): while an open improvement's flag is at Off, the probes take a
 *     baseline of the stable version, once for each version and flag set it runs with: the journeys and the `/device` check, and
 *     pictures of the spec's pages in light and dark, all with the flag off (and again for a baseline missing a page in
 *     either, as one taken before Verify pictured dark is), since every probe request carries the mark, which the flag
 *     is on for from Checks. At Checks and at Preview, the same again, compared with the latest baseline, once for each
 *     of Martin's moves there; at Preview a probe first asks to preview the flag. Each is asked once a pass, and the
 *     probes join the run already going; each run checks the app held the flag set Martin's latest move wrote, before
 *     and after, or it is tried again on the next pass. Then it appends `flag.checked`. Without the probes
 *     (`PROBES_URL`, Verify's), it waits.
 * - **With just one** (`only`), it acts on that work item alone.
 */
import { inBothSchemes, VERSIONS } from '@software-factory/events';
import { redactSecrets } from '@software-factory/events/public';
import type { EventWriter, FlagEvents, StoredFlagCheck } from '@software-factory/store';
import { askedByMartin, flagEvents, fromMartin, lastEnd } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { flagsFrom, stageWords } from '../../../../policy/flag-moves.ts';
import { FLAGS_HELD, type Share, type Stage } from '../../../../policy/flags.ts';
import { release as RELEASE } from '../../../../policy/release.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import { DRY_RUN_NUMBERS_FROM } from '../github/actions.ts';
import { figuresOf, figuresQuery, judge, type Sides, type Span, sidesOf, windowOf } from './compare.ts';
import { type CheckAsked, checkedDraft, FRONT_PAGE, requestOf } from './flag-checks.ts';
import { asEvent } from './gates.ts';
import { closeIssue } from './issues.ts';
import { countRecorded } from './metrics.ts';
import type { FlagChecksPort } from './verify.ts';
import type { GitHubPort } from './worker.ts';

/** A work item a flag was last staged on, as the pass needs it. */
export interface FlagItem {
  /** Whether it is an improvement Martin asked for: its opening and his request both appended by one of his roles. */
  improvement: boolean;
  sample: boolean;
  closed: boolean;
  /**
   * Whether its latest pull request is a dry run's, whose change never reached the app: at Everyone it is not
   * verified, and the line closes it with no change once it runs live (`dryRunLeft`).
   */
  dryRun: boolean;
}

/** What the pass decides from. */
export interface FlagFacts {
  /** The flags' events, as the store tells them. */
  flags: FlagEvents;
  /** Each work item a flag was last staged on (`itemsAsked`), by number: one the store has no opening of is missing. */
  items: Readonly<Record<string, FlagItem>>;
  /** The one work item the line acts on, or null for every one. */
  only: string | null;
  /** Now, in milliseconds: a move to Everyone closes its improvement only once the app has had time to hold it. */
  now: number;
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
      do: 'verified';
      flag: string;
      workItem: string;
      /** Martin's move to Everyone: its place in the store. */
      move: { seq: string };
    }
  | {
      do: 'compare';
      flag: string;
      workItem: string;
      share: Share;
      /** Martin's move to this share: its place in the store, when it was made, and the revision it wrote. */
      move: { seq: string; ts: string; revision: string };
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

/** A baseline the line recorded: a check of a flag at Off. */
type Baseline = StoredFlagCheck & { check: Extract<StoredFlagCheck['check'], { stage: 'off' }> };

/** Whether a baseline was taken before it of the same version and flag set: so it was taken again already. */
const retaken = (baselines: readonly Baseline[], taken: Baseline) =>
  baselines.some(
    (b) => b !== taken && b.check.version === taken.check.version && b.check.revision === taken.check.revision,
  );

/** Whether one place in the store comes after another. */
const after = (seq: string, than: string) => BigInt(seq) > BigInt(than);

/** What the pass does for each flag, given the flags' state: a pure function, so a test drives it with records. */
export function flagsNext({ flags, items, only, now: at }: FlagFacts): FlagNext[] {
  const told = flagsFrom(flags.records, flags.named);
  const next: FlagNext[] = [];
  const revision = flags.revision ?? 'none';
  for (const [flag, now] of Object.entries(told)) {
    const move = flags.records.findLast((r) => r.type === 'flag.staged' && r.flag === flag);
    const checks = flags.checked.filter((c) => c.check.flag === flag);
    /** The baselines taken for an improvement, oldest first: another's, which reused the flag's name, are none of its. */
    const baselinesOf = (item: string) =>
      checks.filter((c): c is Baseline => c.check.stage === 'off' && c.workItem === item);
    // At Off, on an open improvement whose spec names it: the baseline, once for each version the app runs, which the
    // probes tell (`have`). Never staged on it: one staged on an earlier improvement may be named again by this one's
    // spec, and one turned off on this one closes it.
    const named = now.workItem;
    const improvement = named ? items[named] : undefined;
    const taken = named ? (baselinesOf(named).at(-1) ?? null) : null;
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
        // Taken again for a new flag set too: another flag moved meanwhile changes what the probes see; and once more
        // when it is missing a page in a colour scheme, as every baseline taken before Verify pictured dark is. Only
        // once more: a page the probes cannot picture in one scheme would otherwise be taken again every pass.
        ...(taken &&
          taken.check.revision === revision &&
          (inBothSchemes(taken.check.pages) || retaken(baselinesOf(taken.workItem), taken)) && {
            have: taken.check.version,
          }),
        base: null,
        pages: pagesOf(flags, flag),
      });
    }
    const workItem = now.stagedOn;
    if (!workItem || (only !== null && workItem !== only)) continue;
    const item = items[workItem];
    if (!item?.improvement || item.sample) continue;
    /** Whether this pass closes the work item already, for another of its flags: it closes once. */
    const closing = next.some((n) => (n.do === 'close' || n.do === 'verified') && n.workItem === workItem);
    // Turned off, at any stage: Martin's last move went to Off, on this work item. It closes once, whichever of its
    // flags was turned off.
    if (now.last?.to.stage === 'off' && !item.closed && !closing) {
      const reason = (move?.type === 'flag.staged' && move.reason) || NO_REASON;
      next.push({ do: 'close', flag, workItem, from: now.last.from, reason });
    }
    // At Everyone, once the app has had its minute to hold Martin's move there: the improvement is shipped, and closes
    // once, as verified. A flag back on from Everyone is on a work item closed already, and closes nothing.
    if (
      now.last?.to.stage === 'everyone' &&
      !item.closed &&
      !item.dryRun &&
      move?.type === 'flag.staged' &&
      at - Date.parse(move.ts) >= FLAGS_HELD.takeSeconds * 1000 &&
      !closing
    ) {
      next.push({ do: 'verified', flag, workItem, move: { seq: move.seq } });
    }
    // At Share, and not yet compared since Martin's move there: a move clears the comparison before it. On a closed
    // work item too: a flag turned off from Everyone may go back on, be narrowed to Share and wait on a comparison.
    if (now.last?.to.stage === 'share' && !now.compared && move?.type === 'flag.staged') {
      const { seq, ts, revision } = move;
      next.push({ do: 'compare', flag, workItem, share: now.last.to.share, move: { seq, ts, revision } });
    }
    // At Checks or Preview, and not yet checked there since Martin's move: once for each move, against the latest
    // baseline taken for this improvement, whichever version it was taken of.
    const stage = now.last?.to.stage;
    if (
      (stage === 'checks' || stage === 'preview') &&
      move?.type === 'flag.staged' &&
      !checkedSince(checks, stage, move)
    ) {
      // The latest with both schemes, as the hold counted for Checks; the latest of any when none has.
      const baselines = baselinesOf(workItem);
      const base = baselines.findLast((b) => inBothSchemes(b.check.pages)) ?? baselines.at(-1) ?? null;
      const moveRevision = move.revision;
      next.push({
        do: 'check',
        flag,
        workItem,
        stage,
        revision,
        move: move.seq,
        moveRevision,
        base,
        pages: pagesOf(flags, flag),
      });
    }
  }
  return next;
}

/**
 * The pages the probes picture for a flag: those its improvement's latest spec names, the first six as `flag.checked`
 * keeps them, or the front page when it names none.
 */
const pagesOf = (flags: FlagEvents, flag: string): readonly string[] => {
  const named = flags.pages[flag];
  return named?.length ? named.slice(0, 6) : FRONT_PAGE;
};

/** Whether a flag was checked at a stage since a move, of that move: one started for an earlier move is none of its. */
const checkedSince = (
  checks: readonly StoredFlagCheck[],
  stage: 'checks' | 'preview',
  move: { seq: string; revision: string },
) => checks.some((c) => c.check.stage === stage && c.check.moveRevision === move.revision && after(c.seq, move.seq));

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
  /** The GitHub worker, which closes a turned-off improvement's issue: without it, the issue is left as it is. */
  github?: Pick<GitHubPort, 'act'> | null;
  /** The app's repository, as `owner/name`, where the issue is. */
  repo?: string;
}

/** The pass: reads the flags' state, decides, and appends what it decided. */
export class FlagPass {
  readonly #o: FlagPassOptions;
  readonly #sides = new Map<string, Sides>();
  /** The work items a flag was staged on that the pass left out, as Martin did not ask for them: each logged once. */
  readonly #leftOut = new Set<string>();

  constructor(options: FlagPassOptions) {
    this.#o = options;
  }

  async pass(only: string | null): Promise<void> {
    const flags = await flagEvents(this.#o.sql);
    const asked = itemsAsked(flags);
    if (!asked.length) return;
    const items = await this.#items(asked);
    for (const next of flagsNext({ flags, items, only, now: this.#o.now().getTime() })) {
      if (next.do === 'close') await this.#close(next);
      else if (next.do === 'verified') await this.#verified(next);
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
    // The issue first, saying why: closing one already closed says nothing again, so a close the store then refuses is
    // tried again on the next pass with no second comment.
    try {
      await this.#closeIssue(next);
    } catch (error) {
      this.#o.log.warn(
        { workItem: next.workItem, flag: next.flag, err: error },
        'could not close a turned-off improvement’s issue',
      );
      return;
    }
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
   * Closes a turned-off improvement's issue as not planned, with Martin's reason as its public view has it. One with no
   * issue (the line never opened one), or one that is gone, or that the App may not change, is left.
   */
  async #closeIssue(next: Extract<FlagNext, { do: 'close' }>): Promise<void> {
    const { github, repo } = this.#o;
    if (!github || !repo) return;
    const issue = await this.#issueOf(next.workItem);
    if (!issue) return;
    const comment = [
      `Martin turned \`${next.flag}\` off, from ${stageWords(next.from)}: ${redactSecrets(next.reason)}`,
      '',
      `The change stays in the app, behind its flag, off. The factory’s improvement #${next.workItem} is closed.`,
    ].join('\n');
    await closeIssue(github, repo, { number: issue, reason: 'not_planned', comment }, next.workItem, this.#o.log);
  }

  /**
   * Closes an improvement Martin widened to Everyone as verified, and its issue as completed, saying so: the issue
   * first, as for a turned-off one. Martin may have moved the flag since the pass read it: then it closes nothing, and
   * the next pass decides afresh.
   */
  async #verified(next: Extract<FlagNext, { do: 'verified' }>): Promise<void> {
    const { flag, workItem } = next;
    if (!(await this.#latest(next))) return;
    try {
      const issue = await this.#issueOf(workItem);
      const { github, repo } = this.#o;
      if (issue && github && repo) {
        const comment = [
          `Martin widened \`${flag}\` to Everyone: it is on for every visitor, after Verify compared its two sides at Share.`,
          '',
          `The factory’s improvement #${workItem} is closed as verified. Turning the flag off is still one move in the console, and reaches the app in seconds.`,
        ].join('\n');
        await closeIssue(github, repo, { number: issue, reason: 'completed', comment }, workItem, this.#o.log);
      }
    } catch (error) {
      this.#o.log.warn({ workItem, flag, err: error }, 'could not close a verified improvement’s issue');
      return;
    }
    // Once its issue says so, the close is recorded even if Martin has turned the flag off since: it was on for
    // everyone, held a minute, and an Off after a verified close closes nothing more, so the two never disagree.
    const ts = this.#o.now().toISOString();
    const drafts = [
      {
        type: 'work-item.closed' as const,
        actor: 'factory' as const,
        summary: `Closed: ${flag} is on for everyone`,
        payload: {
          outcome: 'verified' as const,
          reason: `Martin widened ${flag} to Everyone, after Verify's comparison at Share passed`,
        },
      },
    ];
    try {
      await this.#o.events.append(drafts.map((draft) => asEvent(workItem, draft, ts)));
    } catch (error) {
      this.#o.log.warn({ workItem, flag, err: error }, 'could not close a verified improvement');
      return;
    }
    countRecorded(drafts);
    this.#o.log.info({ workItem, flag }, 'closed an improvement whose flag is on for everyone');
  }

  /** Whether Martin's move to Everyone is still his latest of the flag. */
  async #latest(next: Extract<FlagNext, { do: 'verified' }>): Promise<boolean> {
    const [row] = await this.#o.sql<{ seq: string }[]>`
      select e.seq::text as seq from events e
      where e.type = 'flag.staged' and e.version <= ${VERSIONS['flag.staged']} and e.payload->>'flag' = ${next.flag}
        and not e.sample and e.work_item is not null
        and e.appended_by is not null and ${fromMartin(this.#o.sql, 'e')}
      order by e.seq desc limit 1`;
    return row?.seq === next.move.seq;
  }

  /** The issue the line opened for a work item, if it did. */
  async #issueOf(workItem: string): Promise<number | null> {
    const [row] = await this.#o.sql<{ issue: number | null }[]>`
      select issue from line where work_item = ${workItem}`;
    return row?.issue ?? null;
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
          moveRevision: next.move.revision,
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
    // Martin may have moved it, or another flag, while the probes ran: then this check is of a flag set gone.
    const now = await flagEvents(this.#o.sql, flag);
    const latest = now.records.findLast((r) => r.type === 'flag.staged');
    if ((latest?.seq ?? null) !== next.move || (now.revision ?? 'none') !== answer.revision) return;
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

  /**
   * Each work item asked about, from its opening: an improvement only if Martin asked for it, as `flagEvents` judges
   * one. One opened as an improvement that he did not ask for is logged once, so it does not drop out unseen.
   */
  async #items(workItems: string[]): Promise<Record<string, FlagItem>> {
    const sql = this.#o.sql;
    const rows = await sql<
      { work_item: string; kind: string; sample: boolean; closed: boolean; asked: boolean; dry_run: boolean }[]
    >`
      select o.work_item, o.payload->>'kind' as kind, o.sample,
             ${lastEnd(sql, 'o.work_item')} is not distinct from 'work-item.closed' as closed,
             ${askedByMartin(sql, 'o.work_item')} as asked,
             coalesce((select (p.payload->>'number')::bigint >= ${DRY_RUN_NUMBERS_FROM} from events p
                       where p.work_item = o.work_item and p.type = 'pull-request.pushed'
                       order by p.seq desc limit 1), false) as dry_run
      from events o where o.type = 'work-item.opened' and o.work_item = any(${workItems})`;
    return Object.fromEntries(
      rows.map((row) => {
        const { asked } = row;
        if (row.kind === 'improvement' && !asked && !row.sample && !this.#leftOut.has(row.work_item)) {
          this.#leftOut.add(row.work_item);
          this.#o.log.warn(
            { workItem: row.work_item },
            'a flag was staged on an improvement Martin did not ask for: the flag pass leaves it out',
          );
        }
        return [
          row.work_item,
          {
            improvement: row.kind === 'improvement' && asked,
            sample: row.sample,
            closed: row.closed,
            dryRun: row.dry_run,
          },
        ];
      }),
    );
  }
}
