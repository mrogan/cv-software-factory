/**
 * Releases that carry no work item, Martin's own commits, and so are the line's: one that the canary rolled back
 * before any step was measured, with no series to keep, which opened #1308; a build of one commit that rolled back the
 * same way, whose signal joined #1308; a build of another that the analysis could not judge, with Prometheus out of
 * reach; one stopped with the line, retried, and aborted by Martin; and the next, promoted, which brought #1306's
 * error back.
 */
import { commitFor, Item, releaseFor, started, stepped } from '../build.ts';

/** How the analysis says a measure failed its release, in Argo Rollouts' words. */
const FAILED = 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)';

/**
 * The latency measure of v0.9.9, as the canary's rollback and its signal both record it. Prometheus had no requests
 * from the canary to compare, and a version with nothing to compare measures as infinitely worse, which no number
 * holds: so it has no value, and the rollback no series.
 */
export const V099_LATENCY = {
  name: 'latency',
  phase: 'failed',
  value: null,
  limit: 0,
  message: FAILED,
} as const;

/** The build of one of Martin's commits that rolled back on Monday evening, as v0.9.9 had. */
export const EVENING = commitFor('martin:monday-evening');

/** The build of another of Martin's commits, out on Monday night, that the analysis could not judge. */
export const NIGHT = commitFor('martin:monday-night');

/** Why the analysis could not judge it, in Argo Rollouts' words: Prometheus did not answer, five times running. */
const ERRORED = 'Metric "errors" assessed Error due to consecutiveErrors (5) > consecutiveErrorLimit (4)';
/** Each measure's own words: what Prometheus's address said. */
const UNREACHABLE =
  'Post "http://prometheus-server.telemetry/api/v1/query": dial tcp 10.43.12.7:80: connect: connection refused';

/** The measures the analysis could not take at 25%, each in its own words. */
const NIGHT_ERRORS = (['enough-requests', 'errors', 'latency'] as const).map((name) => ({
  name,
  phase: 'error' as const,
  value: null,
  limit: name === 'enough-requests' ? 100 : name === 'errors' ? 0.01 : 0,
  message: UNREACHABLE,
}));

export default new Item(null, '2026-10-05T00:00:00+01:00', 'line/releases')
  // Monday: three minutes into the 25% step, latency fails its second look, and the canary rolls back.
  .at(
    '11:20:00',
    'release.started',
    'rollouts',
    'v0.9.9 signed and admitted; canary started',
    started('v0.9.9', 'v0.9.8'),
  )
  .at('11:23:10', 'release.rolled-back', 'rollouts', `Rolled back at 25%: ${FAILED}`, {
    release: releaseFor('v0.9.9'),
    version: 'v0.9.9',
    restored: 'v0.9.8',
    weight: 25,
    reason: FAILED,
    failed: [V099_LATENCY],
    dryRun: false,
  })
  // Monday evening: a build of one of Martin's commits fails latency the same way. #1308 is still open, so triage
  // adds the rollback's signal to it rather than opening another ticket.
  .at(
    '18:40:00',
    'release.started',
    'rollouts',
    `${EVENING.slice(0, 7)} signed and admitted; canary started`,
    started(EVENING, 'v0.9.10'),
  )
  .at('18:43:10', 'release.rolled-back', 'rollouts', `Rolled back at 25%: ${FAILED}`, {
    release: releaseFor(EVENING),
    version: EVENING,
    restored: 'v0.9.10',
    weight: 25,
    reason: FAILED,
    failed: [V099_LATENCY],
    dryRun: false,
  })
  // Monday night: a build of another of Martin's commits reaches its 25% step while Prometheus is out of reach. The
  // analysis cannot take its measures, ends in Error, and Argo Rollouts stops the canary: nothing failed, so it is no
  // rollback and no signal, and the version before takes all the traffic.
  .at(
    '21:10:00',
    'release.started',
    'rollouts',
    `${NIGHT.slice(0, 7)} signed and admitted; canary started`,
    started(NIGHT, 'v0.9.10'),
  )
  .at('21:13:10', 'canary.stepped', 'rollouts', 'Canary at 25%: the analysis could not judge it', {
    release: releaseFor(NIGHT),
    version: NIGHT,
    weight: 25,
    analysis: {
      phase: 'error',
      requests: null,
      measures: [...NIGHT_ERRORS, { name: 'journeys', phase: 'successful', value: null, limit: null }],
    },
    dryRun: false,
  })
  .at('21:13:40', 'release.errored', 'rollouts', `Analysis error at 25%: ${ERRORED}`, {
    release: releaseFor(NIGHT),
    version: NIGHT,
    restored: 'v0.9.10',
    weight: 25,
    reason: ERRORED,
    errored: NIGHT_ERRORS,
    abortedAt: '2026-10-05T20:13:11Z',
  })
  // Tuesday: Martin stops the line with the canary at 50%. Stop the line aborts it, the version before takes all the
  // traffic, and the line records the abort a pass later.
  .at(
    '31:30:00',
    'release.started',
    'rollouts',
    'v0.9.11 signed and admitted; canary started',
    started('v0.9.11', 'v0.9.10'),
  )
  .at(
    '31:33:00',
    'canary.stepped',
    'rollouts',
    'Canary at 25%: the analysis passed',
    stepped('v0.9.11', 25, {
      errorRate: { canary: 0.0022, baseline: 0.002 },
      p99Ms: { canary: 131, baseline: 129 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    }),
  )
  .at('31:35:10', 'line.stopped', 'martin', 'The line stopped: Martin stopped the line', {
    reason: 'Martin stopped the line',
  })
  .aborted('31:35:40', '31:35:11', 'v0.9.11', 'v0.9.10', 'stop')
  .at('31:50:00', 'line.started', 'martin', 'The line started, guarded', { autonomy: 'guarded' })
  // He starts the line again and retries the canary, then aborts it himself, at 25%, for the next deploy.
  .at('31:51:00', 'release.started', 'rollouts', 'v0.9.11 started again after its abort', started('v0.9.11', 'v0.9.10'))
  .aborted('31:53:30', '31:53:02', 'v0.9.11', 'v0.9.10', 'martin')
  // A new deploy starts another release, which goes all the way.
  .released('32:00:00', 'v0.9.12', 'v0.9.10', [
    {
      errorRate: { canary: 0.0021, baseline: 0.0021 },
      p99Ms: { canary: 130, baseline: 131 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
    {
      errorRate: { canary: 0.002, baseline: 0.0022 },
      p99Ms: { canary: 129, baseline: 130 },
      journeys: { canary: [24, 24], baseline: [24, 24] },
    },
  ]);
