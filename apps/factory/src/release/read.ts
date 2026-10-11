/**
 * What the line reads of a release, and nothing it could change: the app's Rollout and its AnalysisRuns, through the
 * Kubernetes API (get and list, in `website` only: deploy/base/analysis/line-reads-release.yaml), and each version's
 * figures from Prometheus, by the pod-template hash Argo Rollouts gives it. It polls; it never watches.
 *
 * The schemas are subsets: only what the release watch (`watch.ts`) reads, so a field Argo Rollouts adds or drops
 * elsewhere changes nothing here.
 */
import type { PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import { release as policy, type Release } from '../../../../policy/release.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import type { Kube } from '../runners/kube.ts';
import { versionQueries } from './analysis.ts';

const condition = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
});

/** The app's Rollout, as far as the watch reads it. */
export const rolloutSchema = z.object({
  metadata: z.object({ name: z.string() }),
  spec: z.object({
    template: z.object({
      spec: z.object({ containers: z.array(z.object({ name: z.string(), image: z.string() })).min(1) }),
    }),
    strategy: z.object({
      canary: z.object({ steps: z.array(z.object({ setWeight: z.number().int().optional() })).default([]) }).optional(),
    }),
  }),
  status: z
    .object({
      /** The version the spec asks for: the canary while a release runs, and the stable version once it is over. */
      currentPodHash: z.string().optional(),
      /** The version that takes the traffic between releases. */
      stableRS: z.string().optional(),
      currentStepIndex: z.number().int().optional(),
      /** Set by Martin's abort and by a failed analysis alike. */
      abort: z.boolean().optional(),
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
});

/** One of the release's AnalysisRuns, as far as the watch reads it. */
export const analysisRunSchema = z.object({
  metadata: z.object({
    name: z.string(),
    creationTimestamp: z.string(),
    labels: z.record(z.string(), z.string()).default({}),
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
            measurements: z.array(measurement).default([]),
          }),
        )
        .default([]),
    })
    .default({ metricResults: [] }),
});
export type AnalysisRun = z.infer<typeof analysisRunSchema>;

const analysisRunList = z.object({ items: z.array(analysisRunSchema) });

/** Which Rollout the line watches: the app's, in the namespace its Role reads. */
export interface RolloutRef {
  namespace: string;
  name: string;
}

/** The Rollout and the AnalysisRuns it owns, or undefined when there is no such Rollout. */
export async function readRollout(
  kube: Kube,
  { namespace, name }: RolloutRef,
): Promise<{ rollout: Rollout; runs: AnalysisRun[] } | undefined> {
  const base = `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(namespace)}`;
  const rollout = await kube.get(`${base}/rollouts/${encodeURIComponent(name)}`, rolloutSchema);
  if (!rollout) return undefined;
  const list = await kube.get(`${base}/analysisruns`, analysisRunList);
  const runs = (list?.items ?? []).filter((run) =>
    run.metadata.ownerReferences.some((owner) => owner.kind === 'Rollout' && owner.name === name),
  );
  return { rollout, runs };
}

type Figures = PayloadOf<'canary.stepped'>['figures'];
type Series = NonNullable<PayloadOf<'release.rolled-back'>['failed'][number]['series']>;

/** A pod-template hash, as Argo Rollouts makes one. */
const HASH = /^[a-z0-9]{1,16}$/;

/**
 * The two versions an AnalysisRun compared, by their pod-template hashes, as the Rollout passed them. The app's
 * repository writes the Rollout, and could pass any text: anything not shaped like a hash is not queried.
 */
export function hashesOf(run: AnalysisRun): { stable: string; canary: string } | undefined {
  const arg = (name: string) => {
    const value = run.spec.args.find((a) => a.name === name)?.value;
    return value && HASH.test(value) ? value : undefined;
  };
  const stable = arg('stable-hash');
  const canary = arg('canary-hash');
  return stable && canary ? { stable, canary } : undefined;
}

/**
 * Each version's own figures over the window that ended at `at`, from the app's telemetry by its pod-template hash.
 * A figure with nothing to measure is null. The journeys give a pass or a fail, not counts, so theirs is null.
 */
export async function figuresAt(
  prometheus: Prometheus,
  hashes: { stable: string; canary: string },
  at: Date,
  r: Release = policy,
): Promise<NonNullable<Figures>> {
  const one = async (hash: string) => {
    const q = versionQueries(r, hash);
    const [requests, errorShare, latency] = await Promise.all(
      [q.requests, q.errorShare, q.latency].map(async (query) => (await prometheus.instant(query, at))[0]?.value),
    );
    return {
      requests: requests === undefined ? null : Math.max(0, Math.round(requests)),
      errorRate: errorShare === undefined ? null : Math.min(1, Math.max(0, errorShare)),
      p99Ms: latency === undefined ? null : Math.max(0, Math.round(latency * 1000)),
      journeys: null,
    };
  };
  const [canary, baseline] = await Promise.all([one(hashes.canary), one(hashes.stable)]);
  return { canary, baseline };
}

/** The measures a rollback can draw, and how: the share of 5xx answers in percent, and the latency in ms. */
const DRAWN = {
  errors: { label: 'share of 5xx answers', unit: '%', query: 'errorShare', scale: 100 },
  latency: { label: 'p99 latency', unit: 'ms', query: 'latency', scale: 1000 },
} as const;

/** The most points a series may have (the event's limit), and the finest step it is drawn at. */
const MAX_POINTS = 500;
const MIN_STEP_SECONDS = 15;

/**
 * A failed measure on the canary and the baseline, from the release's start to the moment it failed, as the analysis
 * compared them; undefined for a measure with nothing to draw (`enough-requests`, the journeys), or when neither
 * version has a value in that time.
 */
export async function seriesOf(
  prometheus: Prometheus,
  measure: string,
  hashes: { stable: string; canary: string },
  from: Date,
  failedAt: Date,
  r: Release = policy,
): Promise<Series | undefined> {
  if (measure !== 'errors' && measure !== 'latency') return undefined;
  const drawn = DRAWN[measure];
  const span = Math.max(0, failedAt.getTime() - from.getTime()) / 1000;
  const stepSeconds = Math.max(MIN_STEP_SECONDS, Math.ceil(span / (MAX_POINTS - 1)));
  // At least two points, the last at the failure.
  const start = new Date(
    failedAt.getTime() - Math.max(stepSeconds, Math.floor(span / stepSeconds) * stepSeconds) * 1000,
  );
  const points = Math.round((failedAt.getTime() - start.getTime()) / 1000 / stepSeconds) + 1;
  const line = async (hash: string) => {
    const series = await prometheus.range(versionQueries(r, hash)[drawn.query], start, failedAt, stepSeconds);
    const values = series?.values ?? new Array<number | null>(points).fill(null);
    return values.slice(0, points).map((v) => (v === null ? null : Math.round(v * drawn.scale * 100) / 100));
  };
  const [canary, baseline] = await Promise.all([line(hashes.canary), line(hashes.stable)]);
  if ([...canary, ...baseline].every((v) => v === null)) return undefined;
  return {
    label: drawn.label,
    unit: drawn.unit,
    start: start.toISOString(),
    stepSeconds,
    canary,
    baseline,
    at: points - 1,
  };
}
