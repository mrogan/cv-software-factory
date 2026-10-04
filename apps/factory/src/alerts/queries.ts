/**
 * The PromQL behind the objectives, written once: the alerting rules judge every route with it, and the intake
 * plots one route's series with it, so the picture on a ticket is exactly what fired.
 *
 * The app's request metrics are OpenTelemetry's HTTP server semantic conventions as Prometheus names them:
 * `http_server_request_duration_seconds` (a histogram) labelled with `http_route` and `http_response_status_code`.
 * `http_route` is the path asked for, such as `/products/glove-left`, and is absent when no route matched.
 */
import type { Objectives } from '../../../../policy/objectives.ts';

const REQUESTS = 'http_server_request_duration_seconds';

/** What a query covers: every route that has one, or the one route. */
export interface Scope {
  route?: string;
}

/** A label value as PromQL spells a string. */
export function quoted(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`;
}

function matchers(o: Objectives, scope: Scope, extra: string[] = []): string {
  const route = scope.route === undefined ? 'http_route!=""' : `http_route=${quoted(scope.route)}`;
  return `{${[`job=${quoted(o.app.metricsJob)}`, route, ...extra].join(', ')}}`;
}

/** `sum by (http_route)` for every route, a plain `sum` for one. */
function sum(scope: Scope, extraLabels: string[] = []): string {
  const labels = [...extraLabels, ...(scope.route === undefined ? ['http_route'] : [])];
  return labels.length ? `sum by (${labels.join(', ')})` : 'sum';
}

const window = (o: Objectives) => `${o.windowMinutes}m`;

/** How many requests the window held. */
export function requests(o: Objectives, scope: Scope = {}): string {
  return `${sum(scope)} (increase(${REQUESTS}_count${matchers(o, scope)}[${window(o)}]))`;
}

/** The share of requests that answered with a 5xx status. */
export function errorRatio(o: Objectives, scope: Scope = {}): string {
  const errors = `${sum(scope)} (rate(${REQUESTS}_count${matchers(o, scope, ['http_response_status_code=~"5.."'])}[${window(o)}]))`;
  const all = `${sum(scope)} (rate(${REQUESTS}_count${matchers(o, scope)}[${window(o)}]))`;
  return `${errors} / ${all}`;
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

/** What the latency objective is called when someone reads it: p95, p99. */
export function percentileName(percentile: number): string {
  return `p${Math.round(percentile * 100)}`;
}
