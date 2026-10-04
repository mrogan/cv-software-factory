/**
 * The app's objectives: what a visitor may fairly expect of any route of a shop. Prometheus's alerting rules are
 * generated from this file (`factory alerts rules`), and `make check` fails if the generated rules are out of date.
 *
 * The same objectives apply to every route. A route is not given a looser one here: a route that cannot meet them is
 * a finding.
 *
 * A rule only judges a route that has had `minRequests` in the window, because the shop's traffic is thin: until the
 * traffic generator arrives, the probes and the crawler are most of it, and one failure in three requests is not a
 * trend. These numbers are a starting point for a small shop, and Martin's to change.
 */
export interface Objectives {
  /** The app, as its own telemetry names it. */
  app: {
    /** The `job` of its request metrics. */
    metricsJob: string;
    /** The `service_name` of its logs. */
    logsService: string;
  };
  /** How far back each rule looks, in minutes. */
  windowMinutes: number;
  /** A route with fewer requests than this in the window is not judged. */
  minRequests: number;
  /** How long a rule must hold before it fires, in minutes: a blip is not an alert. */
  holdMinutes: number;
  /** The share of a route's requests that may answer with a 5xx status. */
  errorRatio: { max: number };
  /** The slowest a route may be for the given share of its requests. */
  latency: { percentile: number; maxSeconds: number };
}

export const objectives = {
  app: { metricsJob: 'worlds-worst-website/website', logsService: 'website' },
  windowMinutes: 15,
  minRequests: 20,
  holdMinutes: 2,
  errorRatio: { max: 0.05 },
  latency: { percentile: 0.95, maxSeconds: 1 },
} satisfies Objectives;
