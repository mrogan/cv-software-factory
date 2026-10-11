/**
 * A rollback is a signal. When the canary's analysis fails a release, the line leaves triage a signal from the
 * `canary` sense for each measure that failed, and triage treats it as any sense's: a ticket, or evidence on the
 * ticket it repeats. Each stands for the symptom class its measure does:
 *
 * | Measure | Symptom class | Route |
 * |---|---|---|
 * | errors | `server-error` | the one route where the canary did worse, or `*` for more than one, or none found |
 * | latency | `slow-response` | as for errors |
 * | journeys | the failing check's own | the failing check's own; `*` when the Job's words are lost |
 *
 * The signal comes from an AnalysisRun whose phase is Failed, never from the Rollout's state: Martin's abort leaves
 * the Rollout as a failed analysis does, but it terminates the runs, which fails none, so an abort sends nothing. Too
 * few requests fails a step too, but says the traffic fell short, not that the canary did worse: it sends nothing.
 *
 * A signal is named by the run, the measure and its route, so the line can send it again after a restart and triage
 * takes it once. Only the runs of a release the line recorded starting are read: an older run still in the cluster
 * was before the line watched.
 */
import type { InboxSignal, PayloadOf, SymptomClass } from '@software-factory/events';
import { uuidFrom } from '@software-factory/triage';
import type { Regression } from '../gates/journeys.ts';
import type { AnalysisRun, RoutesWorse } from './read.ts';
import { failuresOf, measuresOf, type Observed, type Recorded, type Series } from './watch.ts';

type Started = PayloadOf<'release.started'>;
type Measure = PayloadOf<'canary.stepped'>['analysis']['measures'][number];

/** The symptom class each measure stands for. A measure not named here sends no signal. */
const SYMPTOMS: Record<string, SymptomClass | 'journey'> = {
  errors: 'server-error',
  latency: 'slow-response',
  journeys: 'journey',
};

/**
 * The class of a failed journey whose comparison could not be read, or whose check could not finish: a check that
 * passed on the baseline came out wrong on the canary.
 */
export const JOURNEY_FALLBACK: SymptomClass = 'wrong-result';

/** One failed measure of one run, and the release it judged. */
export interface FailedMeasure {
  run: AnalysisRun;
  measure: Measure;
  started: Started;
}

/** Every failed measure that sends a signal, in the runs of the releases the line recorded, oldest run first. */
export function failedMeasures(o: Observed, recorded: Recorded): FailedMeasure[] {
  return [...recorded].flatMap(([name, targets]) => {
    const started = [...targets.values()][0]?.started;
    if (!started) return [];
    return failuresOf(o, name).flatMap((run) =>
      measuresOf(run)
        .filter((measure) => measure.phase === 'failed' && SYMPTOMS[measure.name] !== undefined)
        .map((measure) => ({ run, measure, started })),
    );
  });
}

/** What the line read for a failed measure: its series and the routes where the canary did worse, or the journeys'. */
export interface Read {
  series?: Series;
  routes?: RoutesWorse;
  /** The checks that regressed, as the journeys Job wrote them; undefined when they could not be read. */
  journeys?: Regression[];
}

/** A key for a failed measure, the same on every pass: its run and its name. */
export const keyOf = (failed: Pick<FailedMeasure, 'run' | 'measure'>) =>
  `${failed.run.metadata.uid}/${failed.measure.name}`;

/** A failed measure's signal, and the id it goes in the inbox under. */
export function canarySignal(failed: FailedMeasure, read: Read): { id: string; signal: InboxSignal } {
  const { run, measure, started } = failed;
  const stands = SYMPTOMS[measure.name] ?? JOURNEY_FALLBACK;
  const first = read.journeys?.[0];
  const { routes } = read;
  const worse = routes?.worse ?? [];
  const symptom: SymptomClass = stands === 'journey' ? (first?.symptom ?? JOURNEY_FALLBACK) : stands;
  const route = stands === 'journey' ? (first?.route ?? '*') : worse.length === 1 ? (worse[0]?.route ?? '*') : '*';
  const at =
    run.status.completedAt ??
    run.status.metricResults.find((m) => m.name === measure.name)?.measurements.at(-1)?.finishedAt ??
    run.metadata.creationTimestamp;
  const where = route === '*' ? '' : ` on ${route}`;
  const words = measure.message ?? 'the analysis failed it';
  const signal: InboxSignal = {
    sense: 'canary',
    check: measure.name,
    route,
    version: started.version,
    symptom,
    evidence: [
      {
        kind: 'canary',
        release: started.release,
        version: started.version,
        against: started.previous,
        measure,
        ...(read.series ? { series: read.series } : {}),
        ...(routes?.worse.length ? { routes } : {}),
        ...(read.journeys?.length ? { checks: read.journeys } : {}),
      },
    ],
    observedAt: new Date(at).toISOString(),
    summary: `${short(started.version)} did worse than ${short(started.previous)} on ${measure.name}${where}: ${words}`
      .slice(0, 200)
      .trim(),
    artifacts: [],
  };
  return { id: uuidFrom(`canary:${run.metadata.uid}:${measure.name}:${route}`), signal };
}

const short = (version: string) => (/^[0-9a-f]{8,40}$/.test(version) ? version.slice(0, 7) : version);
