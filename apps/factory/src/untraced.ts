/**
 * The HTTP requests the factory's workers leave out of their traces: routine polling, which repeats many times an hour
 * and says nothing new each time. No imports, since `telemetry.ts` loads it before the instrumentation is in place.
 */

/** Kubernetes probes `/health` every few seconds; a span for each would bury the requests that matter. */
export const untracedIncoming = (request: { url?: string | undefined }): boolean => request.url === '/health';

/**
 * The line's release watch reads the app's Rollout and its AnalysisRuns every 30 seconds (`release/read.ts`): each
 * read would be a root span of its own, and while the line is idle they would be all of its spans. Whatever else it
 * asks of Kubernetes (a runner's Job, the journeys' pods) is traced. In the cluster, that is: on a host the line reaches
 * Kubernetes through `kubectl proxy` with `fetch`, which this instrumentation does not trace at all.
 */
export const untracedOutgoing = (request: {
  method?: string | null | undefined;
  path?: string | null | undefined;
}): boolean =>
  (request.method ?? 'GET').toUpperCase() === 'GET' && (request.path ?? '').startsWith('/apis/argoproj.io/');
