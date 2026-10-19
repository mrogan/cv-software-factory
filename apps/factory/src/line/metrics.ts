/**
 * The line's OpenTelemetry metrics: how work items move through it, and Release and Verify. Until `telemetry.ts`
 * starts an SDK these are no-ops, so tests need none. Every attribute is from a closed list (a stage, an agent, a
 * provider, an outcome, a cause, a sense): never a work item, a job or a release, which would make a series of each.
 *
 * - What happened is counted where the line records it, and only once the store has taken the event, so a series and
 *   the events cannot disagree: holds and verifications in the line's append, releases in the release watch's.
 * - How many work items are at each stage, and how long the oldest has been there, are read from the store's `line`
 *   table each time the SDK collects, not counted in the process: a line that restarts reports the same, and two
 *   replicas report the same figure, so a reader takes the `max` of them, never the `sum`.
 * - How long a work item spent at a stage is recorded as it leaves it, by whichever worker moves it.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import type { PayloadOf } from '@software-factory/events';
import type { Sql } from 'postgres';
import type { LineAgent, QueueStage } from './machine.ts';

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
 * - `failed` or `out-of-turns`: it counts against the step (it handed back nothing, ended failing, its result was
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
  | 'out-of-turns'
  | 'capped'
  | 'stopped'
  | 'stale'
  | 'effects-failed'
  | 'errored';

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

// In seconds, named so with no unit given, as the gateway's dollars are: Prometheus's OTLP receiver then adds nothing
// to the name but its histogram's and counters' own suffixes. A stage can last a minute or a week (a hold over a
// weekend), so the buckets run from a minute to a week.
const stageDuration = meter.createHistogram('line.stage.duration.seconds', {
  description: 'How long a work item was at a stage, in seconds, recorded as it left it',
  advice: { explicitBucketBoundaries: [60, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 86_400, 172_800, 604_800] },
});

const workItems = meter.createObservableGauge('line.work_items', {
  description: 'Work items at each stage of the line, as the store has them',
});

const oldest = meter.createObservableGauge('line.stage.oldest.seconds', {
  description: 'How long the work item longest at each stage has been there, in seconds; 0 with none',
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
