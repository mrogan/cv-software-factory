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
    for await (const page of this.pages(query, start, end, max)) records.push(...page);
    return records;
  }

  /**
   * The same records a page at a time, as Loki gives them, so that a reader that needs no more than one page at once
   * can let each go before the next arrives.
   *
   * Records can share a nanosecond, and a page can end among them, so each page after the first starts at the last
   * one's nanosecond and leaves out the records of it already given. Loki cannot page within one nanosecond: when a
   * page holds nothing new, the rest of that nanosecond is skipped, as it must be for the reading to move on, and only
   * when more records share it than a page holds.
   */
  async *pages(query: string, start: Date, end: Date, max = 20_000): AsyncGenerator<LogRecord[]> {
    let read = 0;
    let from = BigInt(start.getTime()) * 1_000_000n;
    const to = BigInt(end.getTime()) * 1_000_000n;
    /** The records given at the last page's last nanosecond. */
    let given = new Set<string>();
    while (read < max && from < to) {
      const asked = Math.min(PAGE, max - read);
      const answer = (await getJson(this.fetcher, this.base, '/loki/api/v1/query_range', {
        query,
        start: from.toString(),
        end: to.toString(),
        limit: asked,
        direction: 'forward',
      })) as { data?: { result?: { stream?: Record<string, string>; values?: [string, string][] }[] } };
      const answered = (answer.data?.result ?? []).flatMap(({ stream = {}, values = [] }) =>
        values.map(([ns, line]) => ({ ns, time: new Date(Number(BigInt(ns) / 1_000_000n)), line, fields: stream })),
      );
      answered.sort((a, b) => (BigInt(a.ns) < BigInt(b.ns) ? -1 : BigInt(a.ns) > BigInt(b.ns) ? 1 : 0));
      const boundary = from.toString();
      const page = answered.filter((record) => record.ns !== boundary || !given.has(recordIdentity(record)));
      const last = answered.at(-1);
      if (page.length) {
        read += page.length;
        yield page;
      }
      if (!last || answered.length < asked) return;
      if (!page.length) {
        // A page all of one nanosecond, every record of it given already: move past it.
        from = BigInt(last.ns) + 1n;
        given = new Set();
        continue;
      }
      if (last.ns !== boundary) given = new Set();
      for (const record of page) if (record.ns === last.ns) given.add(recordIdentity(record));
      from = BigInt(last.ns);
    }
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

/** What tells two records apart: their time, their line and their labels. */
export function recordIdentity({ ns, line, fields }: LogRecord): string {
  const labels = Object.keys(fields)
    .sort()
    .map((name) => [name, fields[name]]);
  return JSON.stringify([ns, line, labels]);
}
