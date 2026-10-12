/**
 * Releases that carry no work item, Martin's own commits, and so are the line's: one that the canary rolled back
 * before any step was measured, with no series to keep, which opened #1308; one stopped with the line; and the next,
 * promoted, which brought #1306's error back.
 */
import { Item, releaseFor, started, stepped } from '../build.ts';

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
  // Tuesday: Martin stops the line with a canary at 25%. Stopping aborts the canary and writes no release event:
  // v0.9.11 has no end, and the version before takes all the traffic.
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
  .at('31:50:00', 'line.started', 'martin', 'The line started, guarded', { autonomy: 'guarded' })
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
