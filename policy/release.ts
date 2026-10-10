/**
 * How a release of the app is judged: a canary is compared with the version it replaces (its baseline), not with the
 * objectives, because the app is broken on purpose and the baseline already fails some of them. A fix that leaves
 * those as they are is no worse. Argo Rollouts' analysis is generated from this file (`factory`'s
 * `release/analysis.ts`), and `make check` fails if the generated templates are out of date.
 *
 * The steps (how much of the traffic the canary takes, and for how long) are the app's, in its repository's
 * `deploy/`; the judgement is here, so nothing in the app's repository can loosen it. These figures are a start, and
 * Martin's to change.
 *
 * Three measures, at each step: errors and latency from Prometheus, over every route at once, and the journeys: the
 * same comparison the app's pull requests pass (a check that passes on the baseline and fails on the canary, twice),
 * run against the two Services. The journeys have no figures of their own.
 */
import { objectives } from './objectives.ts';

export interface Release {
  /** The app, as its telemetry names it and as the cluster serves it. */
  app: {
    /** The `job` of its request metrics. */
    metricsJob: string;
    /** The stable version's Service: the baseline, and all of the shop between releases. */
    stable: string;
    /** The canary's Service: the new version while a release is in flight. */
    canary: string;
  };
  /** How far back each comparison looks, in minutes: no longer than the shortest of the app's steps. */
  windowMinutes: number;
  /** A step whose canary has answered fewer requests than this in the window fails: too few to judge. */
  minRequests: number;
  /** The canary fails when its share of 5xx answers is more than this above the baseline's (0.01 is a point). */
  errors: { maxAbove: number };
  /**
   * The canary fails when its latency at the percentile is more than `maxRatioAbove` above the baseline's and more
   * than `minSecondsAbove` above it too: a fast route that becomes a little slower is not a regression.
   */
  latency: { percentile: number; maxRatioAbove: number; minSecondsAbove: number };
  /**
   * Errors and latency are also looked at throughout the release, every `intervalMinutes`, once the canary has
   * `minRequests` in the window. A measure fails the release at its `failures`th failed look: one look of many can
   * be one slow request.
   */
  background: { intervalMinutes: number; failures: number };
  /** The traffic generator (`factory traffic`): how many of the shop's pages it asks for each second. */
  traffic: { requestsPerSecond: number };
}

export const release = {
  app: {
    metricsJob: objectives.app.metricsJob,
    stable: 'http://website.website',
    canary: 'http://website-canary.website',
  },
  windowMinutes: 3,
  // A quarter of five requests a second for three minutes is 225: this is under half that, so a step falls short
  // only when the traffic has, not by chance.
  minRequests: 100,
  errors: { maxAbove: 0.01 },
  latency: { percentile: 0.99, maxRatioAbove: 0.25, minSecondsAbove: 0.1 },
  background: { intervalMinutes: 1, failures: 2 },
  traffic: { requestsPerSecond: 5 },
} satisfies Release;
