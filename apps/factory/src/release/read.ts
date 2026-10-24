/**
 * What the line reads of a release, and nothing it could change: the app's Rollout and its AnalysisRuns, and the
 * journeys Jobs' pods for what they found and counted, through the Kubernetes API (get and list, in `website` only:
 * deploy/base/analysis/line-reads-release.yaml), and each version's figures from Prometheus, by the pod-template hash
 * Argo Rollouts gives it. It polls; it never watches.
 *
 * The Rollout's and the runs' schemas are `rollout.ts`'s, which the admin service shares.
 */
import type { PayloadOf } from '@software-factory/events';
import { z } from 'zod';
import { release as policy, type Release } from '../../../../policy/release.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import { comparisonIn, type Regression } from '../gates/journeys.ts';
import type { Kube } from '../runners/kube.ts';
import { routeQueries, versionQueries } from './analysis.ts';
import { type AnalysisRun, analysisRunSchema, type Measurement, type Rollout, rolloutSchema } from './rollout.ts';
import type { RolloutRef } from './rollout-ref.ts';

const analysisRunList = z.object({ items: z.array(analysisRunSchema) });

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
/** The journeys' checks that passed, of how many ran, as the event keeps them. */
type Counted = NonNullable<NonNullable<Figures>['canary']['journeys']>;
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
 * A figure with nothing to measure is null. The journeys' counts are not Prometheus's (`journeysCounted`), so they are
 * null here.
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
export const DRAWN = {
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

/** The routes where the canary did worse on a measure, worst first, each version's figure in `unit`. */
export interface RoutesWorse {
  unit: string;
  worse: { route: string; canary: number; baseline: number }[];
}

/** The most routes a rollback's signal names. */
const MOST_ROUTES = 10;

/**
 * The routes where the canary did worse on a failed measure, from the release's first run to the failure, by the
 * measure's own rule applied to each route the app named: a share of 5xx answers more than the limit above the
 * baseline's on that route; a latency more than the baseline's and its margin. Only routes both versions served are
 * compared. Undefined for a measure that has no figure by route (`enough-requests`, the journeys).
 */
export async function routesWorse(
  prometheus: Prometheus,
  measure: string,
  hashes: { stable: string; canary: string },
  from: Date,
  failedAt: Date,
  r: Release = policy,
): Promise<RoutesWorse | undefined> {
  if (measure !== 'errors' && measure !== 'latency') return undefined;
  const seconds = Math.max(r.windowMinutes * 60, (failedAt.getTime() - from.getTime()) / 1000);
  const byRoute = async (query: string) =>
    new Map(
      (await prometheus.instant(query, failedAt)).flatMap((sample) =>
        sample.labels.http_route ? [[sample.labels.http_route, sample.value] as const] : [],
      ),
    );
  const figures = async (hash: string) => {
    const q = routeQueries(r, hash, seconds);
    if (measure === 'latency') return byRoute(q.latency);
    const [requests, errors] = await Promise.all([byRoute(q.requests), byRoute(q.errors)]);
    return new Map(
      [...requests].flatMap(([route, n]) => (n > 0 ? [[route, (errors.get(route) ?? 0) / n] as const] : [])),
    );
  };
  const [canary, baseline] = await Promise.all([figures(hashes.canary), figures(hashes.stable)]);
  const over = (c: number, b: number) =>
    measure === 'errors'
      ? c - b - r.errors.maxAbove
      : c - b - Math.max(b * r.latency.maxRatioAbove, r.latency.minSecondsAbove);
  const scale = measure === 'errors' ? 100 : 1000;
  const round = (v: number) => Math.round(v * scale * 100) / 100;
  const worse = [...canary]
    .flatMap(([route, c]) => {
      const b = baseline.get(route);
      return b !== undefined && over(c, b) > 0 && ROUTE.test(route) ? [{ route, c, b, by: over(c, b) }] : [];
    })
    .sort((x, y) => y.by - x.by || x.route.localeCompare(y.route))
    .slice(0, MOST_ROUTES)
    .map(({ route, c, b }) => ({ route, canary: round(c), baseline: round(b) }));
  return { unit: measure === 'errors' ? '%' : 'ms', worse };
}

/** A route as an event keeps one. The app names its routes, and anything else is left out. */
const ROUTE = /^\/[^\s]{0,199}$/;

/** A Job's name, as Kubernetes allows one. */
const JOB_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

const podList = z.object({
  items: z.array(
    z.object({
      status: z
        .object({
          containerStatuses: z
            .array(
              z.object({
                name: z.string(),
                state: z.object({ terminated: z.object({ message: z.string().optional() }).optional() }).optional(),
              }),
            )
            .default([]),
        })
        .default({ containerStatuses: [] }),
    }),
  ),
});

/**
 * What the journeys found when they failed a run, as the last failed Job of the run's journeys measure wrote it to its
 * container's termination message (`comparisonMessage`): `found`, the checks that passed on the baseline and failed on
 * the canary; `running`, while the Job's pod is there and its container has not ended (or has no status yet), so there
 * is nothing to read yet; or `lost`, when there is no such Job or pod any more, or its message is missing or says
 * something else.
 */
export type Journeys = { kind: 'found'; regressions: Regression[] } | { kind: 'running' } | { kind: 'lost' };

/**
 * Reads what the journeys found (`Journeys`). It finds the Job's pod by the `job-name` label Kubernetes gives it, in
 * the run's namespace only, and reads a pod whose container ended before one that has not.
 */
export async function journeysOf(kube: Kube, namespace: string, run: AnalysisRun): Promise<Journeys> {
  const measurements = journeysMeasurements(run);
  const failed = [...measurements].reverse().find((m) => m.phase === 'Failed') ?? measurements.at(-1);
  const read = await messagesOf(kube, namespace, failed);
  if (read.kind !== 'ended') return read;
  const regressions = read.messages.map((m) => comparisonIn(m)?.regressions).find((r) => r?.length);
  return regressions ? { kind: 'found', regressions } : { kind: 'lost' };
}

/**
 * How many of the journeys' checks passed, of how many ran, on each version, as the Job of the run's latest journeys
 * measurement wrote them (`comparisonMessage`): the canary is the change, and the baseline the base. Undefined while
 * the Job has not ended, when it or its pod is gone, or when its message holds no counts (a gate that crashed, or one
 * from before the gate counted).
 */
export async function journeysCounted(
  kube: Kube,
  namespace: string,
  run: AnalysisRun,
): Promise<{ canary: Counted; baseline: Counted } | undefined> {
  const read = await messagesOf(kube, namespace, journeysMeasurements(run).at(-1));
  if (read.kind !== 'ended') return undefined;
  const counts = read.messages.map((m) => comparisonIn(m)?.counts).find((c) => c !== undefined);
  if (!counts) return undefined;
  return {
    canary: [counts.change.passed, counts.change.ran],
    baseline: [counts.base.passed, counts.base.ran],
  };
}

const journeysMeasurements = (run: AnalysisRun) =>
  run.status.metricResults.find((m) => m.name === 'journeys')?.measurements ?? [];

/**
 * The termination messages of a journeys measurement's Job, from its pod, found by the `job-name` label Kubernetes
 * gives it, in the run's namespace only: `ended`, with each ended container's message; `running`, while the pod is
 * there and its container has not ended (or has no status yet); `lost`, when the measurement names no Job, or there is
 * no such pod.
 */
async function messagesOf(
  kube: Kube,
  namespace: string,
  measurement: Measurement | undefined,
): Promise<{ kind: 'ended'; messages: (string | undefined)[] } | { kind: 'running' } | { kind: 'lost' }> {
  const job = measurement?.metadata?.['job-name'];
  const where = measurement?.metadata?.['job-namespace'];
  if (!job || !JOB_NAME.test(job) || (where !== undefined && where !== namespace)) return { kind: 'lost' };
  const selector = encodeURIComponent(`job-name=${job}`);
  const pods = await kube.get(
    `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${selector}`,
    podList,
  );
  const items = pods?.items ?? [];
  const ended = items
    .flatMap((pod) => pod.status.containerStatuses)
    .filter((container) => container.name === 'journeys' && container.state?.terminated);
  // A pod is listed before its container has a status (Pending, pulling its image): it is still to run.
  if (!ended.length) return items.length ? { kind: 'running' } : { kind: 'lost' };
  return { kind: 'ended', messages: ended.map((c) => c.state?.terminated?.message) };
}
