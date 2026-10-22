/**
 * The app's releases, as events. The line reads the Rollout and its AnalysisRuns about every thirty seconds
 * (`read.ts`) and appends what they say that it has not recorded: a release starting, each step's analysis, and its
 * promotion or how else it ended. `releaseEvents` is the decision, a pure function of the Rollout, its runs, what is
 * recorded, and what the line read about the new image, as `gateEvents` is for the gates: reading the same state again
 * appends nothing, and a line started again carries on from what it recorded.
 *
 * A release is named by the canary's pod-template hash and the Rollout's revision (`releaseName`). Argo Rollouts gives
 * the same pod template the same hash, and counts the revision up on every new rollout, so pinning an image released
 * before starts a release of its own. Its events go on every work item it carries, each of them getting what it has
 * not had yet; one that carries none has them on the line. Which work items a release carries is decided once, when
 * it starts: those whose fixes merged after the commit the stable version runs, up to the one the new image runs
 * (`line/release.ts`).
 *
 * - **It starts** when the canary's pods are available, so the image was admitted; or it is recorded as refused when
 *   the Rollout says it could not make them. The line records a release only once it knows the version before it.
 * - **Each step** is a step AnalysisRun that ended, in the order they were made: the n-th recorded is the n-th run.
 * - **It is promoted** when it is the stable version.
 * - **It rolls back** when the Rollout is aborted and an AnalysisRun of the release has failed. Only a run whose phase
 *   is Failed fails a release.
 * - **It errs** when the Rollout is aborted, no run of the release has failed, and one ended in Error in the minute
 *   before Argo Rollouts acted on the abort: the analysis could not judge the canary, and aborted the Rollout itself.
 *   That says neither that the canary was worse nor that anybody stopped it, so it is an end of its own, with the run's
 *   words and the measures it could not take, and no signal.
 * - **It is aborted** when the Rollout is aborted and no run of the release has failed or erred: Martin aborted it,
 *   from the console's Canary panel, by stopping the line (`make stop-the-line`) or by hand. His abort terminates the
 *   runs, which fails none (and a terminated step run is no step). To Argo Rollouts each is the same patch of the
 *   Rollout's status, so who aborted it is the line's to say (`Facts.abortedBy`), from his control's own event
 *   (`release.controlled`), or else from whether the line was stopped then. His abort within the minute
 *   after a run ended in Error, before Argo Rollouts acted on the Error, reads as the Error's: the time is all the
 *   Rollout keeps of either.
 * - **Retried after a rollback, an Error or an abort**, a release starts again, under the same name (a retry keeps the
 *   revision), and goes on as before; only a run that fails or errs after that start ends it again.
 *
 * The stable version is the last release of its hash the line recorded that was promoted, or is still in flight
 * (`namedReleases`): the Rollout's revision is that of the version it asks for, and a Rollout sent back to its stable
 * version, with no canary, counts its revision up without releasing anything. An image released again while the line
 * was not looking is a release of its own, found live: its runs at the revision say so, or, where Argo Rollouts kept
 * none, the line's record, whose last promotion is then of another image. The revision is read only once the Rollout's
 * status has caught up with its spec. A release recorded before releases were named by revision is named by its hash
 * alone, and read as it was then: it has every run of its hash, and until it ends it is the release in flight.
 *
 * A stable version the line has no record of, with no release in flight, is recorded as found live: started and
 * promoted at once, by the factory, `watched: false`, on every merged work item no release has carried whose fix is
 * already in it. So the work items that merged before the line watched releases go on to Verify, and the line knows
 * the version the next release replaces.
 *
 * A dry run's merge never shipped, so no Rollout will carry it: in a dry run, `dryRunEvents` releases it by the dry
 * run's word, marked `dryRun`, so a soak goes round.
 */
import { MAX_CANARY_STEPS, type PayloadOf } from '@software-factory/events';
import type { Draft } from '../line/gates.ts';
import type { AnalysisRun, Rollout } from './read.ts';

/** A work item, or null for the line itself. */
export type Target = string | null;

type Started = PayloadOf<'release.started'>;
export type CanaryStep = NonNullable<Started['steps']>[number];
type Stepped = PayloadOf<'canary.stepped'>;
type Measure = Stepped['analysis']['measures'][number];
type Failed = PayloadOf<'release.rolled-back'>['failed'][number];
type Ended = NonNullable<TargetRecord['ended']>;
export type Figures = NonNullable<Stepped['figures']>;
export type Series = NonNullable<Failed['series']>;

/** What one work item (or the line) has recorded of one release. */
export interface TargetRecord {
  /** Its latest start, and when the line recorded it. */
  started: Started;
  startedAt: string;
  /** How many times it started: more than once when it was retried after a rollback. */
  attempts: number;
  /** Steps recorded, over every attempt. */
  steps: number;
  /** Steps recorded before its latest start: the rest are its latest attempt's. */
  stepsBefore: number;
  /** How its latest attempt ended, if it has. */
  ended: 'promoted' | 'rolled-back' | 'errored' | 'aborted' | undefined;
  /** When Argo Rollouts acted on its latest abort, if it was aborted or its analysis erred. */
  abortedAt?: string;
}

/** What is recorded of each release, by its name, and on each target. */
export type Recorded = Map<string, Map<Target, TargetRecord>>;

/** The release events recorded, in order, as the store has them, upcast. */
export function recordedFrom(
  events: readonly { work_item: string | null; ts: string; type: string; payload: unknown }[],
): Recorded {
  const recorded: Recorded = new Map();
  for (const { work_item: target, ts, type, payload } of events) {
    const name = (payload as { release?: string }).release;
    if (!name) continue;
    const targets = recorded.get(name) ?? new Map<Target, TargetRecord>();
    recorded.set(name, targets);
    const record = targets.get(target);
    if (type === 'release.started') {
      targets.set(target, {
        started: payload as Started,
        startedAt: ts,
        attempts: (record?.attempts ?? 0) + 1,
        steps: record?.steps ?? 0,
        stepsBefore: record?.steps ?? 0,
        ended: undefined,
      });
      continue;
    }
    if (!record) continue;
    if (type === 'canary.stepped') record.steps += 1;
    if (type === 'release.promoted') record.ended = 'promoted';
    if (type === 'release.rolled-back') record.ended = 'rolled-back';
    if (type === 'release.aborted' || type === 'release.errored') {
      record.ended = type === 'release.aborted' ? 'aborted' : 'errored';
      record.abortedAt = (payload as PayloadOf<'release.aborted' | 'release.errored'>).abortedAt;
    }
  }
  return recorded;
}

/** The annotation Argo Rollouts keeps its revision in, on the Rollout and on each run it makes. */
const REVISION = 'rollout.argoproj.io/revision';

/** A release's name: the canary's pod-template hash and the Rollout's revision when it started. */
export const releaseName = (hash: string, revision: string) => `${hash}-${revision}`;

/** What the Rollout and its runs say, in the watch's terms. */
export interface Observed {
  /** The version the spec asks for, by its hash: the canary during a release. */
  current: string | undefined;
  stable: string | undefined;
  /** The Rollout's revision: the current version's. */
  revision: string | undefined;
  /** The image of the current version, by digest. */
  digest: string | undefined;
  aborted: boolean;
  /** When Argo Rollouts acted on the abort, to the second; undefined until it has. */
  abortedAt: string | undefined;
  /** Whether the canary's pods were admitted and are available; undefined until the Rollout says either way. */
  admitted: boolean | undefined;
  /** The weight of each step of the Rollout, by its index: the last weight set at or before it. */
  weights: number[];
  /** The canary's steps, as `release.started` records them; null when the Rollout's cannot be read. */
  plan: CanaryStep[] | null;
  stepIndex: number;
  /** Every run of the Rollout, oldest first. */
  runs: AnalysisRun[];
}

const DIGEST = /@(sha256:[0-9a-f]{64})$/;
const ENDED = new Set(['Successful', 'Failed', 'Error', 'Inconclusive']);

export function observe(rollout: Rollout, runs: readonly AnalysisRun[]): Observed {
  const { metadata, status, spec } = rollout;
  // Argo Rollouts writes the revision before the status that names the new version's hash: until the status has
  // caught up with the spec, the revision may be the next version's, and is not read.
  const caughtUp =
    metadata.generation === undefined || String(status.observedGeneration) === String(metadata.generation);
  const revision = caughtUp ? metadata.annotations[REVISION] : undefined;
  const steps = spec.strategy.canary?.steps ?? [];
  const weights: number[] = [];
  for (const [i, step] of steps.entries()) weights.push(step.setWeight ?? weights[i - 1] ?? 0);
  const stepIndex = status.currentStepIndex ?? 0;
  const current = status.currentPodHash;
  // The ReplicaSet could not make the canary's pods: admission refused them. A pod that was made and never became
  // available (it crashed, or its image could not be pulled) says nothing of admission, and the release waits.
  const failedToCreate = status.conditions.some((c) => c.type === 'ReplicaFailure' && c.status === 'True');
  const available =
    current !== undefined &&
    (current === status.stableRS || stepIndex > 0 || (status.canary?.weights?.canary.weight ?? 0) > 0);
  return {
    current,
    stable: status.stableRS,
    revision: revision && /^\d{1,12}$/.test(revision) ? revision : undefined,
    digest: spec.template.spec.containers[0]?.image.match(DIGEST)?.[1],
    aborted: status.abort === true,
    abortedAt: status.abort === true ? status.abortedAt : undefined,
    admitted: available ? true : failedToCreate ? false : undefined,
    weights,
    plan: planOf(steps),
    stepIndex,
    runs: [...runs].sort(
      (a, b) =>
        a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) ||
        a.metadata.name.localeCompare(b.metadata.name),
    ),
  };
}

type RolloutStep = NonNullable<Rollout['spec']['strategy']['canary']>['steps'][number];

const UNITS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, µs: 1e-6, ns: 1e-9 };
const AMOUNT = String.raw`(\d+(?:\.\d*)?|\.\d+)(h|ms|m|s|us|µs|ns)`;

/**
 * A pause's duration in seconds, as Argo Rollouts reads one: a number, or text of bare digits, is seconds; otherwise
 * a Go duration such as `3m` or `1h30m`. Undefined for anything else, and for more seconds than a number holds exactly.
 */
export function secondsOf(duration: string | number): number | undefined {
  const exact = (seconds: number) => (Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined);
  if (typeof duration === 'number') return exact(duration);
  if (/^\d+$/.test(duration)) return exact(Number(duration));
  if (!new RegExp(`^(?:${AMOUNT})+$`).test(duration)) return undefined;
  let seconds = 0;
  for (const [, amount, unit] of duration.matchAll(new RegExp(AMOUNT, 'g'))) {
    seconds += Number(amount) * (UNITS[unit as string] as number);
  }
  return exact(Math.round(seconds));
}

/**
 * The canary's steps as `release.started` records them. Argo Rollouts lists a weight, a pause and an analysis as steps
 * of their own; here each weight set is one step, with the pauses and the analysis that follow it, before the next
 * weight. Steps of any other kind change no weight and are not recorded. Null when a pause's duration cannot be read,
 * when a weight is outside 1 to 100 (a `canary.stepped` is at 1% at the least, so a step at none of the traffic would
 * not match its verdict), including a pause or an analysis before any weight is set, or when there are more steps
 * than an event holds: the steps are then not known, rather than known wrong.
 */
export function planOf(steps: readonly RolloutStep[]): CanaryStep[] | null {
  const plan: CanaryStep[] = [];
  for (const step of steps) {
    if (step.setWeight !== undefined) plan.push({ weight: step.setWeight, pauseSeconds: 0, analysis: false });
    if (!step.pause && !step.analysis) continue;
    const current = plan.at(-1);
    if (!current) return null;
    if (step.analysis) current.analysis = true;
    if (step.pause) {
      if (step.pause.duration === undefined) {
        current.pauseSeconds = null;
        continue;
      }
      const seconds = secondsOf(step.pause.duration);
      if (seconds === undefined) return null;
      if (current.pauseSeconds !== null) current.pauseSeconds += seconds;
      if (!Number.isSafeInteger(current.pauseSeconds ?? 0)) return null;
    }
  }
  return plan.length <= MAX_CANARY_STEPS && plan.every((s) => s.weight >= 1 && s.weight <= 100) ? plan : null;
}

const hashOf = (run: AnalysisRun) => run.metadata.labels['rollouts-pod-template-hash'];
const revisionOf = (run: AnalysisRun) => run.metadata.annotations[REVISION];
const isStep = (run: AnalysisRun) => run.metadata.labels['rollout-type'] === 'Step';

/** Whether a run is of a release. One named by its hash alone, from before the revision, has every run of its hash. */
const isOf = (run: AnalysisRun, release: string) => {
  const [hash, revision] = release.split('-');
  return hashOf(run) === hash && (revision === undefined || revisionOf(run) === revision);
};

/**
 * What is recorded of the release a run is of: under its name, or under its hash alone, from before the revision, while
 * that release was not promoted. A promoted one's hash in a later run is a later release's.
 */
export function recordOf(recorded: Recorded, run: AnalysisRun) {
  const named = recorded.get(releaseName(hashOf(run) ?? '', revisionOf(run) ?? ''));
  const legacy = recorded.get(hashOf(run) ?? '');
  return named ?? (legacy && !ended(legacy, 'promoted') ? legacy : undefined);
}

/** Whether any target recorded a release as ended, or as ended this way. */
const ended = (targets: Map<Target, TargetRecord>, how?: TargetRecord['ended']) =>
  [...targets.values()].some((record) => (how ? record.ended === how : record.ended !== undefined));

/**
 * A release's step runs that have ended, oldest first. A run terminated (by an abort) ends Successful without having
 * judged anything, so it is no step.
 */
export const stepsOf = (o: Observed, release: string) =>
  o.runs.filter((run) => isOf(run, release) && isStep(run) && ENDED.has(run.status.phase ?? '') && !run.spec.terminate);

/** A release's runs that failed: the only ones that fail a release. */
export const failuresOf = (o: Observed, release: string) =>
  o.runs.filter((run) => isOf(run, release) && run.status.phase === 'Failed');

/**
 * A release's runs that could not judge it, and aborted it themselves: each ended in Error in the minute before Argo
 * Rollouts acted on the abort. An earlier one, which Martin retried past, did not make this abort. A terminated run ends
 * Successful, not so.
 */
const errorsOf = (o: Observed, release: string) => {
  const at = Date.parse(o.abortedAt ?? '');
  return o.runs.filter((run) => {
    const ended = Date.parse(run.status.completedAt ?? '');
    return isOf(run, release) && run.status.phase === 'Error' && ended >= at - 60_000 && ended <= at + 1_000;
  });
};

/** Who aborted, in the line's words: "Stop the line aborted", or "Martin aborted". */
export const whoAborted = (by: PayloadOf<'release.aborted'>['by']) =>
  by === 'stop' ? 'Stop the line aborted' : 'Martin aborted';

/** When the first run of a run's release was made: the release's start, as near as the runs say. */
export const startOf = (o: Observed, of: AnalysisRun) =>
  o.runs.find((run) => hashOf(run) === hashOf(of) && revisionOf(run) === revisionOf(of))?.metadata.creationTimestamp;

/** A weight from the Rollout's steps, by a step's index, as an event takes it. */
const weightAt = (o: Observed, index: number) =>
  Math.max(1, Math.min(100, o.weights[Math.min(index, o.weights.length - 1)] ?? 1));

const indexOf = (o: Observed, run: AnalysisRun) => Number(run.metadata.labels['step-index'] ?? o.stepIndex);

/** The weight of the step a run judged, or the step the Rollout was at for a run in the background. */
const weightOf = (o: Observed, run: AnalysisRun): number => weightAt(o, indexOf(o, run));

/**
 * The weight the canary had reached when a run ended the release: its step's, or for one in the background, as far as
 * the steps went.
 */
const endedAt = (o: Observed, release: string, last: AnalysisRun, attempt: readonly AnalysisRun[]): number =>
  isStep(last) ? weightOf(o, last) : reachedWeight(o, release, attempt);

/**
 * The weight the canary had reached when a run in the background failed it, given the step runs of this attempt that
 * ended. The Rollout no longer says: Argo Rollouts sends an aborted canary back to its first step in the same write
 * that records the abort. The step runs do. The canary holds a step the analysis judges until its run passes, then goes
 * on to the next: it was at the step after the last run that passed, or at the last run's step if that one did not
 * pass, or, before any, at the first. A step run made after the last, which the abort terminated or found running,
 * says the canary went on to its step, as when Martin resumed it past an inconclusive one. The weights are the
 * Rollout's, by step index, as each step's are.
 */
function reachedWeight(o: Observed, release: string, attempt: readonly AnalysisRun[]): number {
  const last = attempt.at(-1);
  if (!last) return weightAt(o, 0);
  const later = o.runs.slice(o.runs.indexOf(last) + 1).filter((run) => isOf(run, release) && isStep(run));
  const passed = last.status.phase === 'Successful' ? 1 : 0;
  return weightAt(o, Math.max(indexOf(o, last) + passed, ...later.map((run) => indexOf(o, run))));
}

const PHASES: Record<string, Measure['phase']> = {
  Pending: 'pending',
  Running: 'running',
  Successful: 'successful',
  Failed: 'failed',
  Error: 'error',
  Inconclusive: 'inconclusive',
};
const phaseOf = (phase: string | undefined): Measure['phase'] => PHASES[phase ?? ''] ?? 'pending';
/** How a release ended short of its promotion, as a retry's summary names it. */
const ENDED_WORDS: Record<Exclude<Ended, 'promoted'>, string> = {
  'rolled-back': 'rollback',
  errored: 'analysis error',
  aborted: 'abort',
};
const ENDINGS: Record<Measure['phase'], string> = {
  pending: 'has not started',
  running: 'is running',
  successful: 'passed',
  failed: 'failed',
  error: 'could not judge it',
  inconclusive: 'was inconclusive',
};

/** Argo's words, cut to what an event keeps; nothing when there are none. */
const words = (text: string | undefined, max: number) => {
  const trimmed = text?.trim();
  return trimmed ? trimmed.slice(0, max).trim() : undefined;
};

/** A measurement's value: Argo keeps a Prometheus answer as text, such as `[0.0019]`. Null for none, or infinity. */
function measured(text: string | undefined): number | null {
  if (!text) return null;
  const first = text
    .replace(/^\[|\]$/g, '')
    .split(',')[0]
    ?.trim();
  if (!first) return null;
  const value = Number(first);
  return Number.isFinite(value) ? value : null;
}

/** What a measure is held to, from its condition: `result[0] >= 100` gives 100, `… result[0] <= 0.01` gives 0.01. */
function limitOf(condition: string | null | undefined): number | null {
  const match = condition?.match(/result\[0\]\s*[<>]=?\s*(-?\d+(?:\.\d+)?)/);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** A run's measures, in the analysis's own terms. */
export function measuresOf(run: AnalysisRun): Measure[] {
  return run.status.metricResults.slice(0, 8).map((result) => {
    const last = result.measurements.at(-1);
    const message = words(result.message ?? last?.message, 300);
    return {
      name: result.name,
      phase: phaseOf(result.phase),
      value: measured(last?.value),
      limit: limitOf(run.spec.metrics.find((m) => m.name === result.name)?.successCondition),
      ...(message ? { message } : {}),
    };
  });
}

/** A version as a reader takes it in: a commit by its first seven characters, anything else as it is. */
export const short = (version: string) => (/^[0-9a-f]{8,40}$/.test(version) ? version.slice(0, 7) : version);

/** What the line read about a release it starts recording. */
export interface Start {
  /** The commit the new image runs, from its revision. */
  commit: string;
  signed: boolean;
  /** The work items it carries; none puts its events on the line. */
  carries: string[];
}

/** What the line read for the drafts: a release's start, and the figures and series of its runs, where it read them. */
export interface Facts {
  start?: Start;
  /** Each step's figures, by its run's name. */
  figures: ReadonlyMap<string, Figures>;
  /** Each failed measure's series, by `<run>/<measure>`. */
  series: ReadonlyMap<string, Series>;
  /** The version promoted last, which a release found live replaces as far as the line knows. */
  lastPromoted?: string;
  /** The release the line recorded promoted last, dry runs aside, by its name (`namedReleases`). */
  lastRelease?: string;
  /**
   * Who aborted the Rollout, when it is aborted: Martin, from the console, as his control recorded; Stop the line, if
   * the line was stopped then; or Martin, by hand.
   */
  abortedBy?: PayloadOf<'release.aborted'>['by'];
}

/** What the line must read before it can draft: a release to start, and the step and failed runs to draw. */
export interface Needs {
  /** A release to start recording, and how: watched from the version the line knows, or found live. */
  start?: { release: string; digest: string; found: boolean; previous: Started | undefined };
  steps: AnalysisRun[];
  failures: AnalysisRun[];
  /** Whether a release was aborted, so the line must say by whom. */
  aborted: boolean;
}

/** One target's drafts for a release in flight, and the runs they need read. */
function forTarget(
  o: Observed,
  names: Named,
  name: string,
  record: TargetRecord,
  facts: Facts,
): { drafts: Draft[]; steps: AnalysisRun[]; failures: AnalysisRun[]; aborted: boolean } {
  const drafts: Draft[] = [];
  const live = names.current === name || names.stable === name;
  const { started, ended } = record;
  let retried = false;
  if (ended === 'promoted') return { drafts, steps: [], failures: [], aborted: false };
  if (ended === 'rolled-back' || ended === 'errored' || ended === 'aborted') {
    // Retried, it goes again; otherwise it is over. Retried and aborted again between two reads (by Martin, or by an
    // Error), it has a later abort.
    const abortedAgain = ended !== 'rolled-back' && Date.parse(o.abortedAt ?? '') > Date.parse(record.abortedAt ?? '');
    if (!live || (o.aborted && !abortedAgain)) return { drafts, steps: [], failures: [], aborted: false };
    drafts.push({
      type: 'release.started',
      actor: 'rollouts',
      summary: `${short(started.version)} started again after its ${ENDED_WORDS[ended]}`,
      // The steps as the Rollout has them now: they are no part of the release's name, so they may have changed.
      payload: { ...started, steps: o.plan },
    });
    retried = true;
  }
  const ran = stepsOf(o, name);
  const steps = ran.slice(record.steps);
  for (const run of steps) {
    const measures = measuresOf(run);
    const requests = measures.find((m) => m.name === 'enough-requests')?.value;
    const phase = phaseOf(run.status.phase);
    const weight = weightOf(o, run);
    const figures = facts.figures.get(run.metadata.name);
    drafts.push({
      type: 'canary.stepped',
      actor: 'rollouts',
      summary: `Canary at ${weight}%: the analysis ${ENDINGS[phase]}`,
      payload: {
        release: name,
        version: started.version,
        weight,
        analysis: {
          phase,
          requests: requests === null || requests === undefined ? null : Math.max(0, Math.round(requests)),
          measures,
        },
        ...(figures ? { figures } : {}),
        dryRun: false,
      },
    });
  }
  // A retried release's earlier failures are its earlier attempts': only a run that failed after it started again
  // fails this one. A first attempt's are all its own, however late the line saw it start. Retried and ended again
  // between two reads, its attempt is what ended after the abort the line recorded.
  const inAttempt = (run: AnalysisRun) => {
    const at = Date.parse(run.status.completedAt ?? '');
    if (retried) return at > Date.parse(record.abortedAt ?? '');
    return record.attempts <= 1 || at > Date.parse(record.startedAt);
  };
  let failures: AnalysisRun[] = [];
  let aborted = false;
  // A retry in this pass has recorded none of its steps yet; its earlier attempts' were recorded before it.
  const attempt = () => ran.slice(retried ? record.steps : record.stepsBefore);
  // The stable version took all of the traffic: if the line missed the moment, a later release may be in flight.
  if (names.stable === name) {
    drafts.push({
      type: 'release.promoted',
      actor: 'rollouts',
      summary: `${short(started.version)} promoted to 100%`,
      payload: {
        release: name,
        version: started.version,
        previous: started.previous,
        ...(started.commit ? { commit: started.commit } : {}),
        watched: true,
        dryRun: false,
      },
    });
  } else if (o.aborted && names.current === name && failuresOf(o, name).some(inAttempt)) {
    failures = failuresOf(o, name).filter(inAttempt);
    const last = failures.at(-1) as AnalysisRun;
    const weight = endedAt(o, name, last, attempt());
    const failed: Failed[] = failures
      .flatMap((run) =>
        measuresOf(run)
          .filter((m) => m.phase === 'failed')
          .map((m) => {
            const series = facts.series.get(`${run.metadata.name}/${m.name}`);
            const looks = run.status.metricResults.find((r) => r.name === m.name)?.failed;
            return {
              ...m,
              ...(series ? { series } : {}),
              ...(looks ? { failures: Math.min(looks, 10_000) } : {}),
            };
          }),
      )
      .slice(0, 8);
    const reason = words(last.status.message, 200) ?? 'The analysis failed the canary';
    drafts.push({
      type: 'release.rolled-back',
      actor: 'rollouts',
      summary: `Rolled back at ${weight}%: ${reason}`.slice(0, 200),
      payload: {
        release: name,
        version: started.version,
        restored: started.previous,
        weight,
        reason,
        failed,
        dryRun: false,
      },
    });
  } else if (o.aborted && o.abortedAt && names.current === name && errorsOf(o, name).some(inAttempt)) {
    const errors = errorsOf(o, name).filter(inAttempt);
    const last = errors.at(-1) as AnalysisRun;
    const weight = endedAt(o, name, last, attempt());
    // One measure that erred in more than one run of the attempt is said once, in the latest run's words.
    const byName = new Map(
      errors.flatMap((run) => measuresOf(run).filter((m) => m.phase === 'error')).map((m) => [m.name, m]),
    );
    const errored = [...byName.values()].slice(0, 8);
    const reason = words(last.status.message, 200) ?? 'The analysis could not judge the canary';
    drafts.push({
      type: 'release.errored',
      actor: 'rollouts',
      summary: `Analysis error at ${weight}%: ${reason}`.slice(0, 200),
      payload: {
        release: name,
        version: started.version,
        restored: started.previous,
        weight,
        reason,
        errored,
        abortedAt: o.abortedAt,
      },
    });
  } else if (o.aborted && o.abortedAt && names.current === name) {
    // Recorded once Argo Rollouts has acted on the abort, and the line has said who made it.
    aborted = true;
    const by = facts.abortedBy;
    if (by) {
      drafts.push({
        type: 'release.aborted',
        actor: 'martin',
        summary: `${whoAborted(by)} the canary of ${short(started.version)}`,
        payload: {
          release: name,
          version: started.version,
          restored: started.previous,
          abortedAt: o.abortedAt,
          by,
        },
      });
    }
  }
  return { drafts, steps, failures, aborted };
}

/** The releases the Rollout names, as the line names them: the version the spec asks for, and the stable version. */
export interface Named {
  current: string | undefined;
  stable: string | undefined;
}

/** Whether a release's name is of a hash: at a revision, or by the hash alone, from before the revision. */
const isOfHash = (name: string, hash: string) => name === hash || name.startsWith(`${hash}-`);

/**
 * Whether the stable version, at a revision the line has not recorded, was released there rather than sent back to
 * with no canary. A release leaves runs of its hash at its revision, and a Rollout sent back leaves none; Argo
 * Rollouts keeps only the latest runs, so where there are none, the line's record says (`lastRelease`, the release it
 * recorded promoted last, dry runs aside): sent back to its stable version, the Rollout runs that release, and
 * released while the line was not looking, it runs an image the line last saw promoted before another. That misreads
 * when the line missed a rollback too.
 */
function releasedAtRevision(o: Observed, lastRelease: string | undefined): boolean {
  const { stable, revision } = o;
  if (stable === undefined || revision === undefined) return false;
  if (o.runs.some((run) => hashOf(run) === stable && revisionOf(run) === revision)) return true;
  return lastRelease !== undefined && !isOfHash(lastRelease, stable);
}

/**
 * The releases the Rollout names. The version the spec asks for is the release of its hash at the Rollout's revision,
 * recorded or still to be. The stable version is the last release of its hash the line recorded that was promoted, or
 * is still in flight (its promotion missed): a Rollout goes back only to a version it promoted. With nothing in flight
 * and none such recorded, it is the release of its hash at the Rollout's revision, to be found live; and so it is when
 * that release went out while the line was not looking (`releasedAtRevision`).
 */
export function namedReleases(o: Observed, recorded: Recorded, lastRelease?: string): Named {
  const ofHash = (hash: string) => [...recorded].filter(([name]) => isOfHash(name, hash));
  const asked = o.current && o.revision ? releaseName(o.current, o.revision) : undefined;
  const releases = o.stable === undefined ? [] : ofHash(o.stable);
  const last = releases
    .filter(([, targets]) => !ended(targets, 'rolled-back') && !ended(targets, 'errored') && !ended(targets, 'aborted'))
    .at(-1);
  const promoted = last?.[0];
  if (o.current === o.stable) {
    // One still in flight is the release whose promotion this is; one promoted may have been released again since.
    const again = () => last !== undefined && ended(last[1], 'promoted') && releasedAtRevision(o, lastRelease);
    const name = asked && (recorded.has(asked) || again()) ? asked : (promoted ?? asked);
    return { current: name, stable: name };
  }
  // With a release in flight, the version it replaces must be known: one rolled back, erred or aborted, retried and
  // promoted while the line was not looking, is the last there is.
  const stable = promoted ?? releases.at(-1)?.[0];
  // One named by its hash alone, from before the revision, is the release in flight until it ends.
  const legacy = o.current === undefined ? undefined : recorded.get(o.current);
  const inFlight = legacy !== undefined && !ended(legacy);
  return { current: asked && recorded.has(asked) ? asked : inFlight ? o.current : asked, stable };
}

/** What a release's first events would need: the start, if it is to be recorded now, as `releaseEvents` decides. */
function startOfRelease(o: Observed, names: Named, recorded: Recorded): Needs['start'] {
  const { current, stable } = names;
  const { digest } = o;
  if (!current || !stable || !digest || recorded.has(current)) return undefined;
  const before = recorded.get(stable);
  if (current === stable) {
    // A stable version the line has no record of, and nothing in flight: found live.
    return o.aborted ? undefined : { release: current, digest, found: true, previous: undefined };
  }
  // A release in flight is recorded from the version it replaces, once its pods were admitted or refused.
  const previous = before && [...before.values()].at(-1)?.started;
  if (!previous || o.admitted === undefined) return undefined;
  return { release: current, digest, found: false, previous };
}

/** What the line must read before `releaseEvents` can say all it has to. */
export function releaseNeeds(o: Observed, recorded: Recorded, lastRelease?: string): Needs {
  const names = namedReleases(o, recorded, lastRelease);
  const start = startOfRelease(o, names, recorded);
  const steps: AnalysisRun[] = [];
  const failures: AnalysisRun[] = [];
  let aborted = false;
  const add = (each: ReturnType<typeof forTarget>) => {
    for (const run of each.steps) if (!steps.includes(run)) steps.push(run);
    for (const run of each.failures) if (!failures.includes(run)) failures.push(run);
    aborted ||= each.aborted;
  };
  const empty: Facts = { figures: new Map(), series: new Map() };
  if (start && !start.found) {
    // What it will draft once started, whatever the image's commit turns out to be.
    const started = startedPayload(
      start,
      { commit: '0'.repeat(40), signed: true, carries: [] },
      true,
      undefined,
      o.plan,
    );
    const record: TargetRecord = { started, startedAt: '', attempts: 1, steps: 0, stepsBefore: 0, ended: undefined };
    add(forTarget(o, names, start.release, record, empty));
  }
  for (const name of releasesIn(names)) {
    for (const record of recorded.get(name)?.values() ?? []) add(forTarget(o, names, name, record, empty));
  }
  return { ...(start ? { start } : {}), steps, failures, aborted };
}

/** The versions the Rollout names, by hash: a release in flight, and the stable version it would replace. */
export const podHashes = (o: Observed): string[] =>
  [...new Set([o.current, o.stable])].filter((hash): hash is string => hash !== undefined);

const releasesIn = (names: Named): string[] =>
  [...new Set([names.current, names.stable])].filter((name): name is string => name !== undefined);

function startedPayload(
  start: NonNullable<Needs['start']>,
  read: Start,
  admitted: boolean,
  lastPromoted: string | undefined,
  steps: CanaryStep[] | null,
): Started {
  // A release found live replaces a version the line never saw: the last it saw promoted, or, before any, itself.
  const previous = start.previous?.version ?? lastPromoted ?? read.commit;
  return {
    release: start.release,
    version: read.commit,
    previous,
    commit: read.commit,
    image: { digest: start.digest, signed: read.signed, admitted },
    watched: !start.found,
    // A release found live went through its steps before the line saw it, under whatever the Rollout said then.
    steps: start.found ? null : steps,
    dryRun: false,
  };
}

/**
 * The events the Rollout and its runs call for that are not recorded yet, by the work item (or the line) each goes
 * on. A release to start needs `facts.start`; without it, nothing of that release is drafted.
 */
export function releaseEvents(o: Observed, recorded: Recorded, facts: Facts): Map<Target, Draft[]> {
  const out = new Map<Target, Draft[]>();
  const add = (target: Target, drafts: Draft[]) => {
    if (drafts.length) out.set(target, [...(out.get(target) ?? []), ...drafts]);
  };
  const names = namedReleases(o, recorded, facts.lastRelease);
  const start = startOfRelease(o, names, recorded);
  if (start && facts.start) {
    const read = facts.start;
    const targets: Target[] = read.carries.length ? read.carries : [null];
    if (start.found) {
      const started = startedPayload(start, read, true, facts.lastPromoted, o.plan);
      for (const target of targets) {
        add(target, [
          {
            type: 'release.started',
            actor: 'factory',
            summary: `${short(started.version)} found live: the line did not see it go out`,
            payload: started,
          },
          {
            type: 'release.promoted',
            actor: 'factory',
            summary: `${short(started.version)} is the stable version, found live`,
            payload: {
              release: started.release,
              version: started.version,
              previous: started.previous,
              commit: read.commit,
              watched: false,
              dryRun: false,
            },
          },
        ]);
      }
    } else {
      const admitted = o.admitted === true;
      const started = startedPayload(start, read, admitted, facts.lastPromoted, o.plan);
      const how = `${read.signed ? 'signed' : 'not signed'} and ${admitted ? 'admitted' : 'refused admission'}`;
      const record: TargetRecord = { started, startedAt: '', attempts: 1, steps: 0, stepsBefore: 0, ended: undefined };
      for (const target of targets) {
        add(target, [
          {
            type: 'release.started',
            actor: 'rollouts',
            summary: `${short(read.commit)} ${how}; canary started`,
            payload: started,
          },
          ...forTarget(o, names, start.release, record, facts).drafts,
        ]);
      }
    }
  }
  for (const name of releasesIn(names)) {
    for (const [target, record] of recorded.get(name) ?? []) {
      add(target, forTarget(o, names, name, record, facts).drafts);
    }
  }
  return out;
}

/** How a dry run's release goes: a step at each weight, each a delay after the one before. */
export const DRY_RUN_WEIGHTS = [25, 50];

/** The name a dry run gives the release of a work item's merge. */
export const dryRunRelease = (commit: string) => `dry-run-${commit.slice(0, 12)}`;

/**
 * A dry run's release of one work item's merge, which never shipped: started a delay after the merge, then a step at
 * each of `DRY_RUN_WEIGHTS` and its promotion, each a delay after the one before, all by the dry run's word. Nothing
 * ran, so no step has measures or figures. Its start records those steps as a Rollout's would be, each pausing the
 * delay and ending in a step, so a dry run's release reads as a real one does. Returns what is due by `now` and not
 * recorded.
 */
export function dryRunEvents(
  merge: { commit: string; at: string },
  previous: string,
  record: TargetRecord | undefined,
  now: Date,
  everyMs: number,
): Draft[] {
  const release = dryRunRelease(merge.commit);
  const due = Math.floor((now.getTime() - Date.parse(merge.at)) / Math.max(1, everyMs));
  const version = merge.commit;
  const all: Draft[] = [
    {
      type: 'release.started',
      actor: 'factory',
      summary: `${short(version)} released in a dry run: nothing shipped`,
      payload: {
        release,
        version,
        previous,
        commit: merge.commit,
        watched: true,
        steps: DRY_RUN_WEIGHTS.map((weight) => ({ weight, pauseSeconds: Math.round(everyMs / 1000), analysis: true })),
        dryRun: true,
      },
    },
    ...DRY_RUN_WEIGHTS.map(
      (weight): Draft => ({
        type: 'canary.stepped',
        actor: 'factory',
        summary: `Canary at ${weight}% in a dry run: nothing ran`,
        payload: {
          release,
          version,
          weight,
          analysis: { phase: 'successful', requests: null, measures: [] },
          dryRun: true,
        },
      }),
    ),
    {
      type: 'release.promoted',
      actor: 'factory',
      summary: `${short(version)} promoted in a dry run: nothing shipped`,
      payload: { release, version, previous, commit: merge.commit, watched: true, dryRun: true },
    },
  ];
  const recorded = record ? 1 + record.steps + (record.ended === 'promoted' ? 1 : 0) : 0;
  return all.slice(recorded, Math.max(recorded, Math.min(due, all.length)));
}
