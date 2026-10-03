/**
 * Agreement. A request leaves three records: a count in the metrics, a record in the log and a trace. Over the same
 * window they should say the same number, route by route. Where one disagrees with the other two, that one is wrong:
 *
 * - a route whose requests leave no log record, or far too few, is `missing-log`;
 * - a route whose metrics count something other than what its logs and traces both saw is `wrong-metric`.
 *
 * When all three disagree, or traces are not there yet, nothing can be said of the odd one out, and nothing is.
 * The window should end a few minutes ago, because a trace reaches Tempo a minute or two late.
 */
import type { InboxSignal } from '@software-factory/events';
import type { Objectives } from '../../../../policy/objectives.ts';
import { quoted } from '../alerts/queries.ts';
import type { Loki } from '../clients/loki.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import type { Tempo } from '../clients/tempo.ts';
import { requestLogs } from '../routes.ts';

/** The requests one route had in a window, as each record of them says. `traces` is absent when Tempo had none. */
export interface Counts {
  metrics: number;
  logs: number;
  traces?: number;
}

export interface Tolerance {
  /** Counts this close always agree: a request on the edge of the window may land either side of it. */
  absolute: number;
  /** Counts this close, as a share of the larger, agree. */
  relative: number;
  /** A route with fewer requests than this in the window, by every record, is not judged. */
  minRequests: number;
}

export const TOLERANCE: Tolerance = { absolute: 3, relative: 0.2, minRequests: 5 };

export function agree(a: number, b: number, tolerance: Tolerance): boolean {
  return Math.abs(a - b) <= Math.max(tolerance.absolute, tolerance.relative * Math.max(a, b));
}

export type Disagreement = 'missing-log' | 'wrong-metric';

/** What the three records' counts for a route say is wrong, if they say. */
export function judge({ metrics, logs, traces }: Counts, tolerance: Tolerance = TOLERANCE): Disagreement | undefined {
  if (Math.max(metrics, logs, traces ?? 0) < tolerance.minRequests) return undefined;
  const logsAgreeMetrics = agree(logs, metrics, tolerance);
  if (traces === undefined) {
    // Two records cannot say which is wrong, except that a log with too few records leaves requests unlogged.
    return !logsAgreeMetrics && logs < metrics ? 'missing-log' : undefined;
  }
  const logsAgreeTraces = agree(logs, traces, tolerance);
  const metricsAgreeTraces = agree(metrics, traces, tolerance);
  if (logsAgreeMetrics && logsAgreeTraces && metricsAgreeTraces) return undefined;
  // The log is the odd one out when metrics and traces agree and the log has fewer.
  if (metricsAgreeTraces && !logsAgreeMetrics && logs < metrics) return 'missing-log';
  // The metrics are the odd one out when the log and the traces agree.
  if (logsAgreeTraces && !metricsAgreeTraces) return 'wrong-metric';
  return undefined;
}

/** What one route's requests look like in each record, with the version that served them and its route. */
export interface RouteCounts extends Counts {
  /** The path asked for. */
  path: string;
  /** The route the app's log gives it. */
  route: string;
  version: string | undefined;
}

/** Two windows' counts as one: each route's requests in both. The later window's version and route name win. */
export function combine(earlier: RouteCounts[], later: RouteCounts[]): RouteCounts[] {
  const combined = new Map<string, RouteCounts>(earlier.map((entry) => [entry.path, { ...entry }]));
  for (const entry of later) {
    const before = combined.get(entry.path);
    if (!before) {
      combined.set(entry.path, { ...entry });
      continue;
    }
    combined.set(entry.path, {
      ...entry,
      version: entry.version ?? before.version,
      metrics: before.metrics + entry.metrics,
      logs: before.logs + entry.logs,
      // Traces are known for the pair only when they are known for both.
      ...(before.traces !== undefined && entry.traces !== undefined ? { traces: before.traces + entry.traces } : {}),
    });
  }
  return [...combined.values()];
}

/**
 * The requests each route and version counted in the last `seconds`, series by series before they are summed: the
 * counter now, less the counter then, with a series that did not exist then counted from nothing. A series whose
 * counter went down has restarted (the app's pod restarted on the same version), so it counts from nothing too.
 * `increase` would miss the first requests of a series that began in the window, and in a shop with thin traffic
 * most routes' series do.
 */
export function requestsBetween(job: string, seconds: number): string {
  const counter = (offset = '') => `http_server_request_duration_seconds_count{${job}, http_route!=""}${offset}`;
  const delta = `(${counter()} - (${counter(` offset ${seconds}s`)} or ${counter()} * 0))`;
  return `sum by (http_route, service_version) ((${delta} >= 0) or (${counter()} unless (${delta} >= 0)))`;
}

/** Counts each route's requests between two times, in each of the three records. */
export async function count(
  o: Objectives,
  backends: { prometheus: Prometheus; loki: Loki; tempo: Tempo },
  start: Date,
  end: Date,
): Promise<{ routes: RouteCounts[]; tracesComplete: boolean }> {
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  const job = `job=${quoted(o.app.metricsJob)}`;
  const [metrics, logs, traced] = await Promise.all([
    backends.prometheus.instant(requestsBetween(job, seconds), end),
    backends.loki.instant(`sum by (path, route) (count_over_time(${requestLogs(o)} [${seconds}s]))`, end),
    backends.tempo.serverSpans(o.app.logsService, start, end),
  ]);

  const routes = new Map<string, RouteCounts>();
  const at = (path: string) => {
    let entry = routes.get(path);
    if (!entry) {
      entry = { path, route: path, version: undefined, metrics: 0, logs: 0 };
      routes.set(path, entry);
    }
    return entry;
  };
  // The version of a route is the one that served most of it.
  const busiest = new Map<string, number>();
  for (const { labels, value } of metrics) {
    const entry = at(labels.http_route ?? '');
    entry.metrics += value;
    if (value > (busiest.get(entry.path) ?? 0)) {
      busiest.set(entry.path, value);
      entry.version = labels.service_version;
    }
  }
  for (const { labels, value } of logs) {
    const entry = at(labels.path ?? '');
    entry.logs += value;
    if (labels.route) entry.route = labels.route;
  }
  for (const span of traced.spans) {
    if (!span.route) continue;
    const entry = at(span.route);
    entry.traces = (entry.traces ?? 0) + 1;
  }
  // A route Tempo shows nothing of has traces of zero, once Tempo shows others: it is not simply late.
  const anyTraces = traced.spans.length > 0;
  for (const entry of routes.values()) {
    if (anyTraces) entry.traces ??= 0;
    if (!traced.complete) delete entry.traces;
  }
  return { routes: [...routes.values()].filter((entry) => entry.path), tracesComplete: traced.complete };
}

/**
 * The signal for a route whose records disagree, or nothing if the metrics do not say which version served it.
 * A missing log is shown as the log it should have been: none at all beside the requests counted elsewhere. Wrong
 * metrics are shown as the series they report, with what the other records counted in its name.
 */
export async function signalForDisagreement(
  disagreement: Disagreement,
  entry: RouteCounts,
  backends: { objectives: Objectives; prometheus: Prometheus },
  start: Date,
  end: Date,
): Promise<InboxSignal | undefined> {
  const { version, route } = entry;
  if (!version) return undefined;
  const base = {
    sense: 'logs' as const,
    route,
    version,
    symptom: disagreement,
    observedAt: end.toISOString(),
    artifacts: [],
  };
  if (disagreement === 'missing-log') {
    return {
      ...base,
      check: 'requests in the log',
      evidence: [
        { kind: 'logs', route, version, requests: Math.round(Math.max(entry.metrics, entry.traces ?? 0)), lines: [] },
      ],
    };
  }
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  const job = quoted(backends.objectives.app.metricsJob);
  const picture = await backends.prometheus.range(
    `sum (increase(http_server_request_duration_seconds_count{job=${job}, http_route=${quoted(entry.path)}}[1m]))`,
    new Date(end.getTime() - 3600_000),
    end,
    60,
  );
  const counted = `metrics ${Math.round(entry.metrics)}, logs ${Math.round(entry.logs)}, traces ${entry.traces ?? 0}`;
  return {
    ...base,
    check: 'metrics against logs and traces',
    ...(picture && picture.values.length >= 2
      ? {
          evidence: [
            {
              kind: 'metric' as const,
              name: `Requests a minute. In ${minutes} minutes: ${counted}`.slice(0, 80),
              unit: 'requests',
              start: picture.start.toISOString(),
              stepSeconds: picture.stepSeconds,
              values: picture.values,
            },
          ],
        }
      : {}),
  };
}
