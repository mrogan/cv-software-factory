/**
 * The app's routes as its logs name them. The request metrics and traces say which path was asked for
 * (`/products/glove-left`); the request log also says which route handled it (`/products/:slug`). A ticket is about
 * the route, so that the same fault on two products is one ticket, and this is where a path becomes one.
 */
import type { Objectives } from '../../../policy/objectives.ts';
import { quoted } from './alerts/queries.ts';
import type { LogRecord, Loki } from './clients/loki.ts';

/** The selector of the app's request records: one per request, with `path` and `route` among its fields. */
export function requestLogs(o: Objectives): string {
  return `{service_name=${quoted(o.app.logsService)}} | event="request"`;
}

/** The route of each path that request records show, for paths whose route is not the path itself. */
export function templatesFrom(records: LogRecord[]): Map<string, string> {
  const templates = new Map<string, string>();
  for (const { fields } of records) {
    if (fields.path && fields.route) templates.set(fields.path, fields.route);
  }
  return templates;
}

/** Every path that had a request in the last day, with its route: one query, for a caller with many paths to place. */
export async function routeTemplates(loki: Loki, o: Objectives, now: Date): Promise<Map<string, string>> {
  const samples = await loki.instant(`sum by (path, route) (count_over_time(${requestLogs(o)} [24h]))`, now);
  const templates = new Map<string, string>();
  for (const { labels } of samples) {
    if (labels.path && labels.route) templates.set(labels.path, labels.route);
  }
  return templates;
}

/** How far back to look for a request that went to the path. */
const LOOKBACK_MS = 6 * 60 * 60 * 1000;

/** The route the app's log gives for a path, or the path itself when its log says nothing. */
export async function routeOf(loki: Loki, o: Objectives, path: string, now: Date): Promise<string> {
  const records = await loki.records(
    `${requestLogs(o)} | path=${quoted(path)} | route!=""`,
    new Date(now.getTime() - LOOKBACK_MS),
    now,
    1,
  );
  return templatesFrom(records).get(path) ?? path;
}
