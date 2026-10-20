/**
 * The PromQL behind the objectives, written once: the recording rules the alerts and dashboards read judge every
 * route with it, and the intake plots one route's series with it, so the picture on a ticket is exactly what fired.
 *
 * The app's request metrics are OpenTelemetry's HTTP server semantic conventions as Prometheus names them:
 * `http_server_request_duration_seconds` (a histogram) labelled with `http_route` and `http_response_status_code`.
 * `http_route` is the path asked for, such as `/products/glove-left`, and is absent when no route matched.
 */
import type { Objectives } from '../../../../policy/objectives.ts';
import { METRICS_FROM_THE_APP } from '../provenance.ts';

export const REQUESTS = 'http_server_request_duration_seconds';

/**
 * The bounds of the app's request duration buckets, in seconds: OpenTelemetry's for `http.server.request.duration`,
 * which the app keeps. A request is slower than the latency objective when it is outside the bucket at its bound.
 */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10] as const;

/**
 * What a query covers: every route that has one, or the one route; or every path a route template serves, as one, such
 * as every `/products/:slug`. With a version, only the requests that version of the app served (`service_version`, the
 * commit it was built from).
 */
export interface Scope {
  route?: string;
  template?: string;
  version?: string;
}

/** A label value as PromQL spells a string. */
export function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

/** The app's request series: its job, and only series the collector stamped as from its pods (provenance.ts). */
export function appSeries(o: Objectives): string {
  return `job=${quoted(o.app.metricsJob)}, ${METRICS_FROM_THE_APP}`;
}

/** The selector of the app's request series in a scope, with any further matchers. */
export function matchers(o: Objectives, scope: Scope, extra: string[] = []): string {
  const route =
    scope.template !== undefined
      ? `http_route=~${quoted(templatePattern(scope.template))}`
      : scope.route === undefined
        ? 'http_route!=""'
        : `http_route=${quoted(scope.route)}`;
  const version = scope.version === undefined ? [] : [`service_version=${quoted(scope.version)}`];
  return `{${[appSeries(o), route, ...version, ...extra].join(', ')}}`;
}

/** `sum by (http_route)` for every route, a plain `sum` for one, or for a template's paths together. */
function sum(scope: Scope, extraLabels: string[] = []): string {
  const one = scope.route !== undefined || scope.template !== undefined;
  const labels = [...extraLabels, ...(one ? [] : ['http_route'])];
  return labels.length ? `sum by (${labels.join(', ')})` : 'sum';
}

const window = (o: Objectives) => `${o.windowMinutes}m`;

/** How many requests the window held. */
export function requests(o: Objectives, scope: Scope = {}): string {
  return `${sum(scope)} (increase(${REQUESTS}_count${matchers(o, scope)}[${window(o)}]))`;
}

/** Requests a second over the window; with `extra`, only those its matchers pick. */
export function requestRate(o: Objectives, scope: Scope = {}, extra: string[] = []): string {
  return `${sum(scope)} (rate(${REQUESTS}_count${matchers(o, scope, extra)}[${window(o)}]))`;
}

/** Requests answered with a 5xx status, a second, over the window. */
export function errorRate(o: Objectives, scope: Scope = {}): string {
  return requestRate(o, scope, ['http_response_status_code=~"5.."']);
}

/** The share of requests that answered with a 5xx status. */
export function errorRatio(o: Objectives, scope: Scope = {}): string {
  return `${errorRate(o, scope)} / ${requestRate(o, scope)}`;
}

/** The latency the objective's share of requests came in under, in seconds. */
export function latency(o: Objectives, scope: Scope = {}): string {
  const buckets = `${sum(scope, ['le'])} (rate(${REQUESTS}_bucket${matchers(o, scope)}[${window(o)}]))`;
  return `histogram_quantile(${o.latency.percentile}, ${buckets})`;
}

/** The versions the route's requests came from in the last window, busiest first. */
export function versions(o: Objectives, scope: Scope): string {
  return `sort_desc(sum by (service_version) (increase(${REQUESTS}_count${matchers(o, scope)}[${window(o)}])))`;
}

/**
 * The paths a route template serves, as a regular expression both PromQL and JavaScript read: each `:name` segment is
 * any one segment, and the rest is literal. `/departments/:department` is `/departments/[^/]+`.
 */
export function templatePattern(template: string, segment = '[^/]+'): string {
  return template
    .split('/')
    .map((part) => (part.startsWith(':') ? segment : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
}

/** What the latency objective is called when someone reads it: p95, p99. */
export function percentileName(percentile: number): string {
  return `p${Math.round(percentile * 100)}`;
}
