/**
 * The app's releases, as events. The line reads the Rollout and its AnalysisRuns about every thirty seconds
 * (`read.ts`) and appends what they say that it has not recorded: a release starting, each step's analysis, and its
 * promotion or rollback. `releaseEvents` is the decision, a pure function of the Rollout, its runs, what is recorded,
 * and what the line read about the new image, as `gateEvents` is for the gates: reading the same state again appends
 * nothing, and a line started again carries on from what it recorded.
 *
 * A release is named by the canary's pod-template hash. Its events go on every work item it carries, each of them
 * getting what it has not had yet; one that carries none has them on the line. Which work items a release carries is
 * decided once, when it starts: those whose fixes merged after the commit the stable version runs, up to the one the
 * new image runs (`line/release.ts`).
 *
 * - **It starts** when the canary's pods are available, so the image was admitted; or it is recorded as refused when
 *   the Rollout says it could not make them. The line records a release only once it knows the version before it.
 * - **Each step** is a step AnalysisRun that ended, in the order they were made: the n-th recorded is the n-th run.
 * - **It is promoted** when it is the stable version.
 * - **It rolls back** when the Rollout is aborted and an AnalysisRun of the release has failed. Only a run whose phase
 *   is Failed fails a release. Martin's abort (`make stop-the-line`) terminates the runs, which fails none (and a
 *   terminated step run is no step), so it records nothing: the release stays unfinished, and its work items wait at Release, until he retries it and it goes
 *   on, or a later release carries them. So does an analysis that ends in Error, which says the analysis could not
 *   judge, not that the canary was worse.
 * - **Retried after a rollback**, a release starts again, under the same name, and goes on as before; only a run that
 *   fails after that start rolls it back again.
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
  /** How its latest attempt ended, if it has. */
  ended: 'promoted' | 'rolled-back' | undefined;
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
        ended: undefined,
      });
      continue;
    }
    if (!record) continue;
    if (type === 'canary.stepped') record.steps += 1;
    if (type === 'release.promoted') record.ended = 'promoted';
    if (type === 'release.rolled-back') record.ended = 'rolled-back';
  }
  return recorded;
}

/** What the Rollout and its runs say, in the watch's terms. */
export interface Observed {
  /** The version the spec asks for, by its hash: the canary during a release. */
  current: string | undefined;
  stable: string | undefined;
  /** The image of the current version, by digest. */
  digest: string | undefined;
  aborted: boolean;
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
  const { status, spec } = rollout;
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
    digest: spec.template.spec.containers[0]?.image.match(DIGEST)?.[1],
    aborted: status.abort === true,
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
 * a Go duration such as `3m` or `1h30m`. Undefined for anything else.
 */
export function secondsOf(duration: string | number): number | undefined {
  if (typeof duration === 'number') return Number.isInteger(duration) && duration >= 0 ? duration : undefined;
  if (/^\d+$/.test(duration)) return Number(duration);
  if (!new RegExp(`^(?:${AMOUNT})+$`).test(duration)) return undefined;
  let seconds = 0;
  for (const [, amount, unit] of duration.matchAll(new RegExp(AMOUNT, 'g'))) {
    seconds += Number(amount) * (UNITS[unit as string] as number);
  }
  return Math.round(seconds);
}

/**
 * The canary's steps as `release.started` records them. Argo Rollouts lists a weight, a pause and an analysis as steps
 * of their own; here each weight set is one step, with the pauses and the analysis that follow it, before the next
 * weight. Steps of any other kind change no weight and are not recorded. Null when a pause's duration cannot be read,
 * or there are more steps than an event holds: the steps are then not known, rather than known wrong.
 */
export function planOf(steps: readonly RolloutStep[]): CanaryStep[] | null {
  const plan: CanaryStep[] = [];
  for (const step of steps) {
    if (step.setWeight !== undefined) plan.push({ weight: step.setWeight, pauseSeconds: 0, analysis: false });
    if (!step.pause && !step.analysis) continue;
    // A pause or an analysis before any weight is set holds the canary at none of the traffic.
    if (!plan.length) plan.push({ weight: 0, pauseSeconds: 0, analysis: false });
    const current = plan.at(-1) as CanaryStep;
    if (step.analysis) current.analysis = true;
    if (step.pause) {
      if (step.pause.duration === undefined) {
        current.pauseSeconds = null;
        continue;
      }
      const seconds = secondsOf(step.pause.duration);
      if (seconds === undefined) return null;
      if (current.pauseSeconds !== null) current.pauseSeconds += seconds;
    }
  }
  return plan.length <= MAX_CANARY_STEPS && plan.every((s) => s.weight >= 0 && s.weight <= 100) ? plan : null;
}

const hashOf = (run: AnalysisRun) => run.metadata.labels['rollouts-pod-template-hash'];
const isStep = (run: AnalysisRun) => run.metadata.labels['rollout-type'] === 'Step';

/**
 * A release's step runs that have ended, oldest first. A run terminated (by an abort) ends Successful without having
 * judged anything, so it is no step.
 */
export const stepsOf = (o: Observed, release: string) =>
  o.runs.filter(
    (run) => hashOf(run) === release && isStep(run) && ENDED.has(run.status.phase ?? '') && !run.spec.terminate,
  );

/** A release's runs that failed: the only ones that fail a release. */
export const failuresOf = (o: Observed, release: string) =>
  o.runs.filter((run) => hashOf(run) === release && run.status.phase === 'Failed');

/** When the release's first run was made: its start, as near as the runs say. */
export const startOf = (o: Observed, release: string) =>
  o.runs.find((run) => hashOf(run) === release)?.metadata.creationTimestamp;

/** The weight of the step a run judged, or the step the Rollout was at for a run in the background. */
const weightOf = (o: Observed, run: AnalysisRun): number => {
  const index = Number(run.metadata.labels['step-index'] ?? o.stepIndex);
  return Math.max(1, Math.min(100, o.weights[Math.min(index, o.weights.length - 1)] ?? 1));
};

const PHASES: Record<string, Measure['phase']> = {
  Pending: 'pending',
  Running: 'running',
  Successful: 'successful',
  Failed: 'failed',
  Error: 'error',
  Inconclusive: 'inconclusive',
};
const phaseOf = (phase: string | undefined): Measure['phase'] => PHASES[phase ?? ''] ?? 'pending';
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
}

/** What the line must read before it can draft: a release to start, and the step and failed runs to draw. */
export interface Needs {
  /** A release to start recording, and how: watched from the version the line knows, or found live. */
  start?: { release: string; digest: string; found: boolean; previous: Started | undefined };
  steps: AnalysisRun[];
  failures: AnalysisRun[];
}

/** One target's drafts for a release in flight, and the runs they need read. */
function forTarget(
  o: Observed,
  name: string,
  record: TargetRecord,
  facts: Facts,
): { drafts: Draft[]; steps: AnalysisRun[]; failures: AnalysisRun[] } {
  const drafts: Draft[] = [];
  const live = o.current === name || o.stable === name;
  const { started, ended } = record;
  let retried = false;
  if (ended === 'promoted') return { drafts, steps: [], failures: [] };
  if (ended === 'rolled-back') {
    // Retried, it goes again; otherwise it is over.
    if (!live || o.aborted) return { drafts, steps: [], failures: [] };
    drafts.push({
      type: 'release.started',
      actor: 'rollouts',
      summary: `${short(started.version)} started again after its rollback`,
      // The steps as the Rollout has them now: they are no part of the release's name, so they may have changed.
      payload: { ...started, steps: o.plan },
    });
    retried = true;
  }
  const steps = stepsOf(o, name).slice(record.steps);
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
  // fails this one. A first attempt's are all its own, however late the line saw it start.
  const inAttempt = (run: AnalysisRun) =>
    !retried && (record.attempts <= 1 || Date.parse(run.status.completedAt ?? '') > Date.parse(record.startedAt));
  let failures: AnalysisRun[] = [];
  // The stable version took all of the traffic: if the line missed the moment, a later release may be in flight.
  if (o.stable === name) {
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
  } else if (o.aborted && o.current === name && failuresOf(o, name).some(inAttempt)) {
    failures = failuresOf(o, name).filter(inAttempt);
    const last = failures.at(-1) as AnalysisRun;
    const weight = weightOf(o, last);
    const failed: Failed[] = failures
      .flatMap((run) =>
        measuresOf(run)
          .filter((m) => m.phase === 'failed')
          .map((m) => {
            const series = facts.series.get(`${run.metadata.name}/${m.name}`);
            return series ? { ...m, series } : m;
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
  }
  return { drafts, steps, failures };
}

/** What a release's first events would need: the start, if it is to be recorded now, as `releaseEvents` decides. */
function startOfRelease(o: Observed, recorded: Recorded): Needs['start'] {
  const { current, stable, digest } = o;
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
export function releaseNeeds(o: Observed, recorded: Recorded): Needs {
  const start = startOfRelease(o, recorded);
  const steps: AnalysisRun[] = [];
  const failures: AnalysisRun[] = [];
  const add = (each: ReturnType<typeof forTarget>) => {
    for (const run of each.steps) if (!steps.includes(run)) steps.push(run);
    for (const run of each.failures) if (!failures.includes(run)) failures.push(run);
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
    add(forTarget(o, start.release, { started, startedAt: '', attempts: 1, steps: 0, ended: undefined }, empty));
  }
  for (const name of named(o)) {
    for (const record of recorded.get(name)?.values() ?? []) add(forTarget(o, name, record, empty));
  }
  return { ...(start ? { start } : {}), steps, failures };
}

/** The versions the Rollout names: a release in flight, and the stable version it would replace. */
export const named = (o: Observed): string[] =>
  [...new Set([o.current, o.stable])].filter((name): name is string => name !== undefined);

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
  const start = startOfRelease(o, recorded);
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
      const record: TargetRecord = { started, startedAt: '', attempts: 1, steps: 0, ended: undefined };
      for (const target of targets) {
        add(target, [
          {
            type: 'release.started',
            actor: 'rollouts',
            summary: `${short(read.commit)} ${how}; canary started`,
            payload: started,
          },
          ...forTarget(o, start.release, record, facts).drafts,
        ]);
      }
    }
  }
  for (const name of named(o)) {
    for (const [target, record] of recorded.get(name) ?? []) add(target, forTarget(o, name, record, facts).drafts);
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
