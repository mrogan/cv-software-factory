/**
 * Verify by variant at the share stage (milestone 7, task 17): a flag's two sides compared on the traffic generator's
 * own requests, flag on against flag off, with the canary's thresholds (`policy/release.ts`). The pass over the flags
 * (`flags.ts`) asks for a comparison; everything it is made of is here, and pure, but for the one question to
 * Prometheus.
 *
 * - **The sides, by flagd's own rule.** Each of the generator's 101 ids is on the side the app would put it: the flag
 *   rendered as the admin service writes it (`policy/flags.ts`), evaluated with flagd's evaluation library, the one
 *   the app's in-process provider evaluates with and at its version, in the context the app builds for a signed
 *   request. Which ids are on depends on the flag's name as well as its share.
 * - **The generator's own figures, by id** (`factory_traffic_request_duration_seconds`, TRAFFIC-GENERATOR.md), and only
 *   the series the collector stamped as from the generator's pod (`provenance.ts`): the app may send the collector
 *   metrics of any name and job, but not those labels, so the code being judged cannot mark its own work, and visitors
 *   are never in them. Requests
 *   are the `+Inf` bucket; errors are 5xx answers and no answer at all; the 99th percentile is interpolated over each
 *   side's buckets as `histogram_quantile` does, after summing them, so the window's pieces join exactly.
 * - **The window**: from when the app holds Martin's move to now, less every canary's time in flight, whose two
 *   versions would mix with the two sides. One question to Prometheus for each piece left.
 * - **The judgement**: the canary's, flag on as the canary and flag off as its baseline, once each side has enough
 *   requests and the window is long enough; until then, nothing.
 */
import { FlagdCore } from '@openfeature/flagd-core';
import type { Share } from '../../../../policy/flags.ts';
import { flagsSpec } from '../../../../policy/flags.ts';
import { release as RELEASE, type Release } from '../../../../policy/release.ts';
import type { Sample } from '../clients/http.ts';
import { METRICS_FROM_THE_TRAFFIC_GENERATOR } from '../provenance.ts';
import { IDS } from '../traffic/share.ts';

/** The generator's histogram, and the `job` its metrics carry (`service.namespace/service.name`). */
export const TRAFFIC_HISTOGRAM = 'factory_traffic_request_duration_seconds';
export const TRAFFIC_JOB = 'software-factory/traffic';

/**
 * The evaluation context the app builds for a request the generator signed (the app's `src/flags/index.ts`): its id as
 * the targeting key, signed, not the factory's mark, and previewing nothing.
 */
export const signedContext = (id: string) => ({
  targetingKey: id,
  signed: true,
  marked: false,
  preview: [] as string[],
});

/** The revision the sides are worked out with: the flag's targeting does not read it. */
const ANY_REVISION = 'r0';

const QUIET = { error() {}, warn() {}, info() {}, debug() {} };

/** The generator's ids on each side of a flag at a share, as the app puts them. */
export interface Sides {
  on: string[];
  off: string[];
}

/** Each of the generator's ids on its side of the flag at the share, by flagd's own evaluation. */
export function sidesOf(flag: string, share: Share): Sides {
  // Interpreted, not compiled: the library's default builds each rule into code it evaluates, which the line needs no
  // more of. The test holds the interpreter's sides to the app's, which compiles.
  const core = new FlagdCore(undefined, QUIET, { disableDynamicCodeGeneration: true });
  core.setConfigurations(JSON.stringify(flagsSpec({ [flag]: { stage: 'share', share } }, ANY_REVISION).flagSpec));
  const sides: Sides = { on: [], off: [] };
  for (const id of IDS) {
    const { variant, reason } = core.resolveBooleanEvaluation(flag, false, signedContext(id), QUIET);
    if (variant !== 'on' && variant !== 'off') throw new Error(`flagd put ${id} on no side of ${flag} (${reason})`);
    sides[variant].push(id);
  }
  return sides;
}

/** A stretch of time, in milliseconds since the epoch. */
export interface Span {
  from: number;
  to: number;
}

/** The window's pieces, each whole seconds long, and how much was set aside for canaries. */
export interface Window {
  pieces: Span[];
  /** The time the pieces cover, in milliseconds. */
  judgedMs: number;
  /** The time canaries were in flight in the window, in milliseconds, which no piece covers. */
  setAsideMs: number;
}

/**
 * The window from `from` to `to`, less each canary's span (already padded): the pieces left, each cut to whole seconds
 * from its end, as a range in PromQL is, and dropped when it is shorter than a second.
 */
export function windowOf(from: number, to: number, canaries: readonly Span[]): Window {
  let pieces: Span[] = to > from ? [{ from, to }] : [];
  for (const canary of canaries) {
    pieces = pieces.flatMap((piece) => {
      if (canary.to <= piece.from || canary.from >= piece.to) return [piece];
      return [
        ...(canary.from > piece.from ? [{ from: piece.from, to: canary.from }] : []),
        ...(canary.to < piece.to ? [{ from: canary.to, to: piece.to }] : []),
      ];
    });
  }
  const length = (spans: Span[]) => spans.reduce((sum, piece) => sum + piece.to - piece.from, 0);
  const setAsideMs = Math.max(0, to - from) - length(pieces);
  pieces = pieces.flatMap((piece) => {
    const seconds = Math.floor((piece.to - piece.from) / 1000);
    return seconds >= 1 ? [{ from: piece.to - seconds * 1000, to: piece.to }] : [];
  });
  return { pieces, judgedMs: length(pieces), setAsideMs };
}

/** What Prometheus is asked for one piece of the window, at its end: each id's buckets, by the class of its answer. */
export function figuresQuery(seconds: number): string {
  const buckets = `${TRAFFIC_HISTOGRAM}_bucket{job="${TRAFFIC_JOB}", ${METRICS_FROM_THE_TRAFFIC_GENERATOR}, share_id!="none"}`;
  // The increase over the piece, which counts across a generator restart, of each series there as it began; and the
  // whole of each series born in it, which the generator makes at its first request of that id and class, and whose
  // first count an increase would take as where it starts: so an id's first 5xx is not lost.
  return `sum by (share_id, status_class, le) ((increase(${buckets}[${seconds}s]) and ${buckets} offset ${seconds}s) or ${buckets})`;
}

/** One side's figures, as `flag.compared` records them: none when it had no requests. */
export interface SideFigures {
  requests: number;
  errorRate: number | null;
  p99Ms: number | null;
}

/** One side's requests, errors and cumulative buckets (upper bound to count), summed over every piece. */
interface Tally {
  requests: number;
  errors: number;
  buckets: Map<number, number>;
}

const ERRORS = new Set(['5xx', 'none']);

/** The quantile of cumulative buckets, as Prometheus's `histogram_quantile` interpolates it; null with no requests. */
export function quantile(q: number, buckets: ReadonlyMap<number, number>): number | null {
  const sorted = [...buckets].sort(([a], [b]) => a - b);
  // Increase over a reset can leave a bucket below the one before it: Prometheus evens them out, as here.
  for (let i = 1; i < sorted.length; i++) {
    const [le, count] = sorted[i] as [number, number];
    const before = (sorted[i - 1] as [number, number])[1];
    if (count < before) sorted[i] = [le, before];
  }
  const last = sorted.at(-1);
  if (sorted.length < 2 || !last || last[0] !== Number.POSITIVE_INFINITY || last[1] <= 0) return null;
  const rank = q * last[1];
  const b = sorted.findIndex(([, count]) => count >= rank);
  if (b === sorted.length - 1) return (sorted[b - 1] as [number, number])[0];
  const [end, count] = sorted[b] as [number, number];
  if (b === 0 && end <= 0) return end;
  const [start, below] = b === 0 ? [0, 0] : (sorted[b - 1] as [number, number]);
  return start + (end - start) * ((rank - below) / (count - below));
}

/** Each side's figures from the answers for every piece of the window. An id on neither side is not counted. */
export function figuresOf(samples: readonly Sample[], sides: Sides, percentile = RELEASE.latency.percentile) {
  const side = new Map<string, keyof Sides>([
    ...sides.on.map((id) => [id, 'on'] as const),
    ...sides.off.map((id) => [id, 'off'] as const),
  ]);
  const tallies: Record<keyof Sides, Tally> = {
    on: { requests: 0, errors: 0, buckets: new Map() },
    off: { requests: 0, errors: 0, buckets: new Map() },
  };
  for (const { labels, value } of samples) {
    const which = side.get(labels.share_id ?? '');
    const le = labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(labels.le);
    if (!which || Number.isNaN(le)) continue;
    const tally = tallies[which];
    tally.buckets.set(le, (tally.buckets.get(le) ?? 0) + value);
    if (le === Number.POSITIVE_INFINITY) {
      tally.requests += value;
      if (ERRORS.has(labels.status_class ?? '')) tally.errors += value;
    }
  }
  const figures = (tally: Tally): SideFigures & { p99Seconds: number | null } => {
    const p99Seconds = tally.requests > 0 ? quantile(percentile, tally.buckets) : null;
    return {
      requests: Math.round(tally.requests),
      errorRate: tally.requests > 0 ? Math.min(1, tally.errors / tally.requests) : null,
      p99Ms: p99Seconds === null ? null : Math.round(p99Seconds * 1000),
      p99Seconds,
    };
  };
  return { on: figures(tallies.on), off: figures(tallies.off) };
}

/** A comparison judged, or why it waits. */
export type Judgement =
  | { kind: 'wait'; why: string }
  | { kind: 'judged'; outcome: 'passed' | 'failed'; reason?: string };

const percent = (rate: number | null) => (rate === null ? 'none' : `${(rate * 100).toFixed(2)}%`);
const ms = (seconds: number) => `${Math.round(seconds * 1000)} ms`;

/**
 * The canary's judgement, flag on as the canary and flag off as its baseline: errors more than `errors.maxAbove` above,
 * or a tail more than `latency.maxRatioAbove` and `latency.minSecondsAbove` above, fails. It waits until each side has
 * `minRequests` and the window, less what was set aside, is `flags.windowMinutes` long.
 */
export function judge(
  on: ReturnType<typeof figuresOf>['on'],
  off: ReturnType<typeof figuresOf>['off'],
  judgedMs: number,
  r: Pick<Release, 'minRequests' | 'errors' | 'latency' | 'flags'> = RELEASE,
): Judgement {
  const minutes = judgedMs / 60_000;
  if (minutes < r.flags.windowMinutes) {
    return { kind: 'wait', why: `${minutes.toFixed(1)} of the ${r.flags.windowMinutes} minutes the window needs` };
  }
  if (on.requests < r.minRequests || off.requests < r.minRequests) {
    return {
      kind: 'wait',
      why: `${on.requests} requests with the flag on and ${off.requests} off, of the ${r.minRequests} each side needs`,
    };
  }
  const reasons: string[] = [];
  if ((on.errorRate ?? 0) - (off.errorRate ?? 0) > r.errors.maxAbove) {
    reasons.push(`errors ${percent(on.errorRate)} with the flag on against ${percent(off.errorRate)} off`);
  }
  // With requests on each side, each has a tail; none would be no figure to judge, which fails, as the canary's does.
  const onTail = on.p99Seconds ?? Number.POSITIVE_INFINITY;
  const offTail = off.p99Seconds ?? 0;
  if (onTail > offTail + Math.max(offTail * r.latency.maxRatioAbove, r.latency.minSecondsAbove)) {
    const p = `p${Math.round(r.latency.percentile * 100)}`;
    reasons.push(
      `${p} ${on.p99Seconds === null ? 'none' : ms(on.p99Seconds)} with the flag on against ${ms(offTail)} off`,
    );
  }
  if (!reasons.length) return { kind: 'judged', outcome: 'passed' };
  const said = reasons.join('; ');
  return { kind: 'judged', outcome: 'failed', reason: `${said[0]?.toUpperCase()}${said.slice(1)}` };
}
