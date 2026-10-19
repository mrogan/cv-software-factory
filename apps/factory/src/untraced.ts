/**
 * The HTTP requests the factory's workers leave out of their traces: routine polling, which repeats many times an hour
 * and says nothing new each time. No imports, since `telemetry.ts` loads it before the instrumentation is in place.
 */

/** Kubernetes probes `/health` every few seconds; a span for each would bury the requests that matter. */
export const untracedIncoming = (request: { url?: string | undefined }): boolean => request.url === '/health';

/**
 * The line's release watch reads the app's Rollout and its AnalysisRuns every 30 seconds (`release/read.ts`). A
 * request out made outside a span makes none anyway (`instrumentations.ts`); these are left out inside one too, so a
 * span that reads a release is not buried in its reads. Whatever else is asked of Kubernetes inside a span (a runner's
 * Job, the journeys' pods) is traced, through `node:http` in the cluster or `fetch` through `kubectl proxy` on a host.
 */
export const untracedOutgoing = (request: {
  method?: string | null | undefined;
  path?: string | null | undefined;
}): boolean =>
  (request.method ?? 'GET').toUpperCase() === 'GET' && (request.path ?? '').startsWith('/apis/argoproj.io/');
