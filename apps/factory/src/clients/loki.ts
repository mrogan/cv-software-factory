/**
 * Loki's HTTP API. The app's records arrive through the collector over OTLP, so only the service is a stream label;
 * every field of a record (`event`, `route`, `path`, `status`, `trace_id`, its level) is structured metadata, which
 * Loki returns beside the labels and a query can filter on as if it were one.
 */
import { type Fetch, getJson, type Sample, samplesOf } from './http.ts';

export interface LogRecord {
  /** Nanoseconds since the epoch, as Loki keeps them: a string, because a number loses the last digits. */
  ns: string;
  time: Date;
  /** The record's message. */
  line: string;
  /** The stream's labels and the record's structured metadata. */
  fields: Record<string, string>;
}

/** Loki refuses to return more than this many records for one query. */
const PAGE = 5000;

export class Loki {
  private readonly base: string;
  private readonly fetcher: Fetch;

  constructor(base: string, fetcher: Fetch = fetch) {
    this.base = base;
    this.fetcher = fetcher;
  }

  /** The records the query selects between two times, oldest first, as many as `max`. */
  async records(query: string, start: Date, end: Date, max = 20_000): Promise<LogRecord[]> {
    const records: LogRecord[] = [];
    let from = BigInt(start.getTime()) * 1_000_000n;
    const to = BigInt(end.getTime()) * 1_000_000n;
    while (records.length < max && from < to) {
      const asked = Math.min(PAGE, max - records.length);
      const answer = (await getJson(this.fetcher, this.base, '/loki/api/v1/query_range', {
        query,
        start: from.toString(),
        end: to.toString(),
        limit: asked,
        direction: 'forward',
      })) as { data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] } };
      const page = (answer.data?.result ?? []).flatMap(({ stream = {}, values = [] }) =>
        values.map(([ns, line]) => ({ ns, time: new Date(Number(BigInt(ns) / 1_000_000n)), line, fields: stream })),
      );
      page.sort((a, b) => (BigInt(a.ns) < BigInt(b.ns) ? -1 : BigInt(a.ns) > BigInt(b.ns) ? 1 : 0));
      records.push(...page);
      const last = page.at(-1);
      if (!last || page.length < asked) break;
      from = BigInt(last.ns) + 1n;
    }
    return records;
  }

  /** A metric query's value at one time, one sample per series. */
  async instant(query: string, at: Date): Promise<Sample[]> {
    return samplesOf(
      await getJson(this.fetcher, this.base, '/loki/api/v1/query', {
        query,
        time: String(BigInt(at.getTime()) * 1_000_000n),
      }),
    );
  }
}
