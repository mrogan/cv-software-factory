/**
 * The line's OpenTelemetry metrics: how work items move through it, and Release and Verify. Until `telemetry.ts`
 * starts an SDK these are no-ops, so tests need none. Every attribute is from a closed list (a stage, an agent, a
 * provider, an outcome, a cause, a sense): never a work item, a job or a release, which would make a series of each.
 *
 * But one: `line.hold.age` has a series for each hold that waits for Martin, named by its work item and, where he
 * answers it on GitHub, its pull request, so the alert for a new hold can say which and link it. Those series are as
 * many as the holds waiting for him, a handful, and each ends with its hold, reading 0, and goes when the line next
 * starts; both labels are numbers the store assigned, never a title, a reason or anything a visitor wrote.
 *
 * - What happened is counted where the line records it, and only once the store has taken the event, so a series and
 *   the events cannot disagree: holds and verifications in the line's append, releases in the release watch's.
 * - How many work items are at each stage, and how long the oldest has been there, are read from the store's `line`
 *   table each time the SDK collects, not counted in the process: a line that restarts reports the same, and two
 *   replicas report the same figure, so a reader takes the `max` of them, never the `sum`.
 * - How long a work item spent at a stage is recorded as it leaves it, by whichever worker moves it.
 * - Each count starts at 0 as the line starts, for every label set it can count (`zeroCounts`): Prometheus's
 *   `increase` and `changes` read nothing into a series' first sample, so a series that started at 1 would lose the
 *   first step, hold, release or verification of each kind after every restart.
 */
import { type Attributes, type BatchObservableResult, metrics } from '@opentelemetry/api';
import { HOLD_CAUSES, type HoldCause, type PayloadOf, SENSES, STAGES } from '@software-factory/events';
import type { Sql } from 'postgres';
import { openHolds } from './holds.ts';
import { type LineAgent, type QueueStage, STAGE_OF } from './machine.ts';

const meter = metrics.getMeter('factory-line');

export type OpenStage = Exclude<QueueStage, 'ended'>;

/** Every stage but `ended`: a record, so a stage added to the queue's and left out here fails to type-check. */
const EVERY_STAGE: Record<OpenStage, true> = {
  plan: true,
  build: true,
  waiting: true,
  gates: true,
  review: true,
  release: true,
  verify: true,
  held: true,
};

/** The stages a work item waits at on the line: every one the `line` table allows but `ended`. */
export const OPEN_STAGES = Object.keys(EVERY_STAGE) as OpenStage[];

/**
 * How a step ended, as the line counts it:
 * - `done`: its result was acted on, and recorded;
 * - `failed` or `max-turns`: it counts against the step (it handed back nothing, ended failing, its result was
 *   refused, or it ran out of turns), and it runs again up to a limit;
 * - `capped`: it ended at a spend cap set while it ran, and runs again when the cap clears;
 * - `stopped`: the line stopped it, and it runs again when the line starts;
 * - `stale`: something was recorded meanwhile that made its result out of date, and it runs again;
 * - `effects-failed`: its result could not be put in GitHub or the store as often as the line tries, and the work item
 *   holds;
 * - `errored`: something outside the agent failed (a read of GitHub, the runners, the store), the line logs it, and the
 *   next pass tries the step again.
 *
 * A result whose effects failed and wait to be tried again has not ended yet: it is counted when they end.
 */
export type StepEnding =
  | 'done'
  | 'failed'
  | 'max-turns'
  | 'capped'
  | 'stopped'
  | 'stale'
  | 'effects-failed'
  | 'errored';

/** Every way a step ends: a record, so an ending added to `StepEnding` and left out here fails to type-check. */
const EVERY_ENDING: Record<StepEnding, true> = {
  done: true,
  failed: true,
  'max-turns': true,
  capped: true,
  stopped: true,
  stale: true,
  'effects-failed': true,
  errored: true,
};

/** Every outcome a verification has, the same way. */
const EVERY_VERIFICATION: Record<PayloadOf<'verification.finished'>['outcome'], true> = {
  cleared: true,
  persists: true,
};

/** The holds triage starts, which are triage's to count (or a hold that recorded no cause): the line starts the rest. */
const NOT_THE_LINES: readonly HoldCause[] = ['suggestion', 'finding', 'burst', 'environment', 'unknown'];

/** How a release ended: each of the release events that ends one. */
export const RELEASE_ENDINGS = {
  'release.promoted': 'promoted',
  'release.rolled-back': 'rolled-back',
  'release.aborted': 'aborted',
  'release.errored': 'errored',
} as const;

const steps = meter.createCounter('line.steps', {
  description: 'Agents’ steps the line ran, by agent, provider and how they ended',
});

const holds = meter.createCounter('line.holds', {
  description: 'Holds for Martin the line started, by cause and the stage held at',
});

const releases = meter.createCounter('line.releases', {
  description: 'Releases the line recorded the end of, by how they ended and whether a dry run’s',
});

const verifications = meter.createCounter('line.verifications', {
  description:
    'Verifications after a release, by sense, whether the signal cleared or persists, and whether a dry run’s',
});

// A stage can last a minute or a week (a hold over a weekend), so the buckets run from a minute to a week.
const stageDuration = meter.createHistogram('line.stage.duration', {
  description: 'How long a work item was at a stage, recorded as it left it',
  unit: 's',
  advice: { explicitBucketBoundaries: [60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 86_400, 172_800, 604_800] },
});

const workItems = meter.createObservableGauge('line.work_items', {
  description: 'Work items at each stage of the line, as the store has them',
});

const oldest = meter.createObservableGauge('line.stage.oldest', {
  description: 'How long the work item longest at each stage has been there; 0 with none',
  unit: 's',
});

export function countStep(agent: LineAgent, provider: string, outcome: StepEnding): void {
  steps.add(1, { agent, provider, outcome });
}

/**
 * A work item left `from` after `seconds` there. Its end is no stage, and a move to the same stage is none, unless it
 * starts its time there afresh (`again`), as a reopened work item taken back into Plan does.
 */
export function leftStage(from: QueueStage, to: QueueStage, seconds: number, again = false): void {
  if ((from === to && !again) || from === 'ended') return;
  stageDuration.record(Math.max(0, seconds), { stage: from });
}

/** An event the line drafted, as far as counting it goes. */
export interface Counted {
  type: string;
  payload: unknown;
}

/** Counts the holds and verifications among events the store has taken from the line. */
export function countRecorded(events: readonly Counted[]): void {
  for (const event of events) {
    if (event.type === 'hold.started') {
      const { cause, stage } = event.payload as PayloadOf<'hold.started'>;
      holds.add(1, { cause, stage });
    } else if (event.type === 'verification.finished') {
      const v = event.payload as PayloadOf<'verification.finished'>;
      verifications.add(1, { sense: v.sense ?? 'unknown', outcome: v.outcome, dry_run: v.dryRun === true });
    }
  }
}

/** A release's end, once. */
export interface Ending {
  type: keyof typeof RELEASE_ENDINGS;
  release: string;
  dryRun: boolean;
}

/** Each release's end among events, once however many work items they record it on. */
export function endingsIn(events: readonly Counted[]): Ending[] {
  const endings = new Map<string, Ending>();
  for (const { type, payload } of events) {
    if (!Object.hasOwn(RELEASE_ENDINGS, type)) continue;
    const { release, dryRun } = payload as { release: string; dryRun?: boolean };
    endings.set(`${type} ${release}`, { type: type as Ending['type'], release, dryRun: dryRun === true });
  }
  return [...endings.values()];
}

/** What the line counts by, as it starts. */
export interface Counting {
  /** The provider each agent's calls go to, as the line counts its steps. */
  providerOf: (agent: LineAgent) => string;
  /** Whether the line runs a dry run, whose releases and verifications it counts with `dry_run` true. */
  dryRun: boolean;
}

/**
 * Starts every count at 0 for each label set the line can count, so the first of each after a restart is counted:
 * each agent's step by its provider and each way it ends; each hold the line starts, by cause, at each stage from Plan
 * on; each release's end; and each sense's verification. A real release can end under a dry run too, so `dry_run`
 * false always, and true only on a dry run. Adding 0 again is harmless.
 */
export function zeroCounts({ providerOf, dryRun }: Counting): void {
  const agents = Object.keys(STAGE_OF) as LineAgent[];
  for (const agent of agents) {
    for (const outcome of Object.keys(EVERY_ENDING)) steps.add(0, { agent, provider: providerOf(agent), outcome });
  }
  const stages = STAGES.slice(STAGES.indexOf('plan'));
  for (const cause of HOLD_CAUSES.filter((c) => !NOT_THE_LINES.includes(c))) {
    for (const stage of stages) holds.add(0, { cause, stage });
  }
  for (const dry_run of dryRun ? [false, true] : [false]) {
    for (const outcome of Object.values(RELEASE_ENDINGS)) releases.add(0, { outcome, dry_run });
    // `unknown` for one that names no sense: a dry run's whose ticket no sense saw, or one recorded before senses were.
    for (const sense of [...SENSES, 'unknown']) {
      for (const outcome of Object.keys(EVERY_VERIFICATION)) verifications.add(0, { sense, outcome, dry_run });
    }
  }
}

/** A release's end, the first time the store records it: on however many work items it carried, it is one. */
export function countReleaseEnd({ type, dryRun }: Ending): void {
  releases.add(1, { outcome: RELEASE_ENDINGS[type], dry_run: dryRun });
}

/**
 * Reports the work items at each stage, and the oldest's time there, from the store, each time the SDK collects,
 * until the function it gives back is called. Every stage is reported, with none as 0, so a stage that empties reads
 * as empty rather than as gone. A read that fails reports nothing that time.
 */
export function observeStages(sql: Sql): () => void {
  const callback = async (result: BatchObservableResult) => {
    const rows = await sql<{ stage: OpenStage; n: number; oldest: number }[]>`
      select stage, count(*)::int as n,
             extract(epoch from clock_timestamp() - min(moved_at))::float8 as oldest
      from line where stage <> 'ended' group by stage`;
    const by = new Map(rows.map((row) => [row.stage, row]));
    for (const stage of OPEN_STAGES) {
      const row = by.get(stage);
      result.observe(workItems, row?.n ?? 0, { stage });
      result.observe(oldest, Math.max(0, row?.oldest ?? 0), { stage });
    }
  };
  meter.addBatchObservableCallback(callback, [workItems, oldest]);
  return () => meter.removeBatchObservableCallback(callback, [workItems, oldest]);
}

const holdAge = meter.createObservableGauge('line.hold.age', {
  description:
    'How long each hold that waits for Martin has waited, by work item, cause and the pull request he answers it on, if any; 0 once it no longer waits',
  unit: 's',
});

/**
 * Reports each hold that waits for Martin (`holds.ts`), as the store has it, each time the SDK collects, until the
 * function it gives back is called: one series per hold, by `work_item`, `cause` and, where there is one,
 * `pull_request`, whose value is how long it has waited. A hold that is answered, or that stops waiting for him (a
 * deploy pull request's checks running again), reads 0 from then: the SDK goes on sending a series' last value after
 * its callback stops observing it, so the process remembers which it has reported, only to say once that each has
 * ended. What waits is the store's alone. A line that starts again reports only what waits then. A read that fails
 * reports nothing that time.
 */
export function observeHolds(sql: Sql): () => void {
  const reported = new Map<string, Attributes>();
  const callback = async (result: BatchObservableResult) => {
    const now = Date.now();
    const open = new Map<string, Attributes>();
    const ages = new Map<string, number>();
    for (const hold of await openHolds(sql)) {
      const attributes = {
        work_item: hold.workItem,
        cause: hold.cause,
        ...(hold.pullRequest !== undefined && { pull_request: String(hold.pullRequest) }),
      };
      const key = JSON.stringify(attributes);
      open.set(key, attributes);
      ages.set(key, Math.max(1, (now - hold.since.getTime()) / 1000));
    }
    for (const [key, attributes] of reported) {
      if (open.has(key)) continue;
      result.observe(holdAge, 0, attributes);
      reported.delete(key);
    }
    for (const [key, attributes] of open) {
      result.observe(holdAge, ages.get(key) ?? 1, attributes);
      reported.set(key, attributes);
    }
  };
  meter.addBatchObservableCallback(callback, [holdAge]);
  return () => meter.removeBatchObservableCallback(callback, [holdAge]);
}
