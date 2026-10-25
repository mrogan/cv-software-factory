/**
 * The app's Rollout and its AnalysisRuns, as the line reads them, and what they say: their schemas, `observe`, and the
 * releases the Rollout names, as the line names them (`namedReleases`). On their own, with nothing but the events
 * package, zod and the line's records (`recorded.ts`) to import, so the admin service reads the Rollout as the line does
 * without the watch's reads, its drafts and their settings.
 *
 * The schemas are subsets: only what the line and the admin service read, so a field Argo Rollouts adds or drops
 * elsewhere changes nothing here.
 */
import { MAX_CANARY_STEPS, type PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import { REVISION, type Recorded, releaseName, type Target, type TargetRecord } from './recorded.ts';

const condition = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

/** The app's Rollout, as far as the watch reads it. */
export const rolloutSchema = z.object({
  metadata: z.object({
    name: z.string(),
    /** Counted up on each change to the spec; the status says which it has caught up with. */
    generation: z.number().int().optional(),
    /** `rollout.argoproj.io/revision`: the version the spec asks for, counted up on each new rollout. */
    annotations: z.record(z.string(), z.string()).default({}),
  }),
  spec: z.object({
    template: z.object({
      spec: z.object({ containers: z.array(z.object({ name: z.string(), image: z.string() })).min(1) }),
    }),
    strategy: z.object({
      canary: z
        .object({
          steps: z
            .array(
              z.object({
                setWeight: z.number().int().optional(),
                /** A pause with no duration waits for someone to promote the canary. */
                pause: z.object({ duration: z.union([z.string(), z.number()]).optional() }).optional(),
                /** Only whether there is one: what it measures is the AnalysisTemplate's. */
                analysis: z.object({}).optional(),
              }),
            )
            .default([]),
        })
        .optional(),
    }),
  }),
  status: z
    .object({
      /** The version the spec asks for: the canary while a release runs, and the stable version once it is over. */
      currentPodHash: z.string().optional(),
      /** The spec's generation this status was written for: Argo Rollouts keeps it as text. */
      observedGeneration: z.union([z.string(), z.number()]).optional(),
      /** The version that takes the traffic between releases. */
      stableRS: z.string().optional(),
      currentStepIndex: z.number().int().optional(),
      /** Set by Martin's abort and by a failed analysis alike. */
      abort: z.boolean().optional(),
      /** When the controller first saw the abort, to the second, cut short; dropped when it is not such a time. */
      abortedAt: z.iso.datetime({ offset: true }).optional().catch(undefined),
      canary: z
        .object({
          weights: z.object({ canary: z.object({ weight: z.number().int() }) }).optional(),
        })
        .optional(),
      conditions: z.array(condition).default([]),
    })
    .default({ conditions: [] }),
});
export type Rollout = z.infer<typeof rolloutSchema>;

const measurement = z.object({
  phase: z.string().optional(),
  /** As Argo Rollouts keeps it: a Prometheus answer is a list written as text, such as `[0.0019]`. */
  value: z.string().optional(),
  message: z.string().optional(),
  finishedAt: z.string().optional(),
  /** For a Job's measure, the Job that took it: `job-name`. */
  metadata: z.record(z.string(), z.string()).optional(),
});

export type Measurement = z.infer<typeof measurement>;

/** One of the release's AnalysisRuns, as far as the watch reads it. */
export const analysisRunSchema = z.object({
  metadata: z.object({
    name: z.string(),
    /** Kubernetes's own id for the run: a rollback's signals are named by it. */
    uid: z.string(),
    creationTimestamp: z.string(),
    labels: z.record(z.string(), z.string()).default({}),
    /** `rollout.argoproj.io/revision`: the Rollout's revision when it made the run. */
    annotations: z.record(z.string(), z.string()).default({}),
    ownerReferences: z.array(z.object({ kind: z.string(), name: z.string() })).default([]),
  }),
  spec: z.object({
    args: z.array(z.object({ name: z.string(), value: z.string().optional() })).default([]),
    /** Set when the run was stopped before its end: by an abort, or because the release went on without it. */
    terminate: z.boolean().optional(),
    metrics: z.array(z.object({ name: z.string(), successCondition: z.string().nullish() })).default([]),
  }),
  status: z
    .object({
      phase: z.string().optional(),
      message: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      metricResults: z
        .array(
          z.object({
            name: z.string(),
            phase: z.string().optional(),
            message: z.string().optional(),
            /** How many of its looks failed, across the run: Argo Rollouts fails the run when this passes the limit. */
            failed: z.number().int().nonnegative().optional().catch(undefined),
            measurements: z.array(measurement).default([]),
          }),
        )
        .default([]),
    })
    .default({ metricResults: [] }),
});
export type AnalysisRun = z.infer<typeof analysisRunSchema>;

/** One of the canary's steps, as `release.started` records it. */
export type CanaryStep = NonNullable<PayloadOf<'release.started'>['steps']>[number];

/** What the Rollout and its runs say, in the watch's terms. */
export interface Observed {
  /** The version the spec asks for, by its hash: the canary during a release. */
  current: string | undefined;
  stable: string | undefined;
  /** The Rollout's revision: the current version's. */
  revision: string | undefined;
  /** The image of the current version, by digest. */
  digest: string | undefined;
  /** Where that image is in GHCR, as GHCR names it (`owner/name`), or undefined when it is not there. */
  image: string | undefined;
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
/** An image in GHCR, by its name there, with or without a tag. */
const IN_GHCR = /^ghcr\.io\/([a-z0-9._-]+(?:\/[a-z0-9._-]+)*)(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/;

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
    image: spec.template.spec.containers[0]?.image.match(IN_GHCR)?.[1],
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

export const hashOf = (run: AnalysisRun) => run.metadata.labels['rollouts-pod-template-hash'];
export const revisionOf = (run: AnalysisRun) => run.metadata.annotations[REVISION];

/** Whether any target recorded a release as ended, or as ended this way. */
export const ended = (targets: Map<Target, TargetRecord>, how?: TargetRecord['ended']) =>
  [...targets.values()].some((record) => (how ? record.ended === how : record.ended !== undefined));

/** The releases the Rollout names, as the line names them: the version the spec asks for, and the stable version. */
export interface Named {
  current: string | undefined;
  stable: string | undefined;
}

/** Whether a release's name is of a hash: at a revision, or by the hash alone, from before the revision. */
export const isOfHash = (name: string, hash: string) => name === hash || name.startsWith(`${hash}-`);

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

/** The versions the Rollout names, by hash: a release in flight, and the stable version it would replace. */
export const podHashes = (o: Observed): string[] =>
  [...new Set([o.current, o.stable])].filter((hash): hash is string => hash !== undefined);
