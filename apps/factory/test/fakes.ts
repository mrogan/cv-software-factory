/**
 * Fakes for the telemetry backends: a `fetch` that answers from a table, so the clients run as they do against the
 * real ones, with no cluster. A request nothing in the table matches fails the test.
 */
import type { Fetch } from '../src/clients/http.ts';

export type Handler = (url: URL) => unknown;

/** The first entry whose path matches and whose `when` (if any) holds for the query answers, as JSON. */
export function fakeFetch(
  table: { path: string; when?: (url: URL) => boolean; answer: Handler }[],
  seen: URL[] = [],
): Fetch {
  return (async (input: URL | string | Request) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    seen.push(url);
    const entry = table.find((e) => e.path === url.pathname && (e.when?.(url) ?? true));
    if (!entry) throw new Error(`No fake answer for ${url.pathname}?${url.search}`);
    return new Response(JSON.stringify(entry.answer(url)), { headers: { 'content-type': 'application/json' } });
  }) as Fetch;
}

/** A Prometheus or Loki instant answer. */
export const vector = (...series: [Record<string, string>, number][]) => ({
  status: 'success',
  data: { resultType: 'vector', result: series.map(([metric, value]) => ({ metric, value: [0, String(value)] })) },
});

/** A Prometheus range answer: one series of [seconds, value] points. */
export const matrix = (points: [number, number][]) => ({
  status: 'success',
  data: { resultType: 'matrix', result: [{ metric: {}, values: points.map(([t, v]) => [t, String(v)]) }] },
});

/** A Loki range answer: records as [nanoseconds, line, fields]. */
export const streams = (...records: [string, string, Record<string, string>][]) => ({
  status: 'success',
  data: {
    resultType: 'streams',
    result: records.map(([ns, line, stream]) => ({ stream, values: [[ns, line]] })),
  },
});

export const VERSION = 'c02efd8f964de8e81d96b4e476577eddd5ced0db';
/** Nanoseconds for a time. */
export const ns = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);
