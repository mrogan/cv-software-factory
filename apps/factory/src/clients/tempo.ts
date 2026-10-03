/**
 * Tempo's HTTP API. A trace is not queryable until a minute or two after its spans are sent (BACKLOG.md), so every
 * caller treats "not there yet" as an answer and never waits for one.
 */
import { type Fetch, getJson } from './http.ts';

export interface ServerSpan {
  traceId: string;
  /** The `http.route` of the request: the path asked for. Empty when no route matched. */
  route: string;
}

export interface SpanSummary {
  name: string;
  offsetMs: number;
  durationMs: number;
}

interface Attribute {
  key: string;
  value: Record<string, string>;
}

export class Tempo {
  private readonly base: string;
  private readonly fetcher: Fetch;

  constructor(base: string, fetcher: Fetch = fetch) {
    this.base = base;
    this.fetcher = fetcher;
  }

  /**
   * The server spans of a service between two times, one for each request that has been indexed. `complete` is false
   * when the answer holds as many as were asked for, so there may be more.
   */
  async serverSpans(
    service: string,
    start: Date,
    end: Date,
    limit = 1000,
  ): Promise<{ spans: ServerSpan[]; complete: boolean }> {
    const answer = (await getJson(
      this.fetcher,
      this.base,
      '/api/search',
      {
        q: `{ resource.service.name = ${JSON.stringify(service)} && kind = server && span.http.route != nil } | select(span.http.route)`,
        start: Math.floor(start.getTime() / 1000),
        end: Math.ceil(end.getTime() / 1000),
        limit,
        spss: 10,
      },
      20_000,
    )) as { traces?: { traceID: string; spanSet?: { spans?: { attributes?: Attribute[] }[] } }[] };
    const traces = answer.traces ?? [];
    const spans = traces.flatMap((trace) =>
      (trace.spanSet?.spans ?? []).map((span) => ({
        traceId: trace.traceID,
        route: span.attributes?.find((a) => a.key === 'http.route')?.value.stringValue ?? '',
      })),
    );
    return { spans, complete: traces.length < limit };
  }

  /** The spans of a trace, in the order they began, or nothing if Tempo does not have it yet. */
  async spans(traceId: string): Promise<SpanSummary[] | undefined> {
    let answer: {
      batches?: Batch[];
      trace?: { resourceSpans?: Batch[] };
    };
    try {
      answer = (await getJson(this.fetcher, this.base, `/api/traces/${traceId}`, {}, 5000)) as typeof answer;
    } catch {
      return undefined;
    }
    const raw = (answer.batches ?? answer.trace?.resourceSpans ?? []).flatMap((batch) =>
      (batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []),
    );
    if (raw.length === 0) return undefined;
    const spans = raw
      .map((span) => ({ name: span.name, start: BigInt(span.startTimeUnixNano), end: BigInt(span.endTimeUnixNano) }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    const origin = spans[0]?.start ?? 0n;
    const ms = (nanoseconds: bigint) => Number(nanoseconds / 1_000_000n);
    return spans.map((span) => ({
      name: span.name,
      offsetMs: ms(span.start - origin),
      durationMs: ms(span.end - span.start),
    }));
  }
}

interface Batch {
  scopeSpans?: { spans?: { name: string; startTimeUnixNano: string; endTimeUnixNano: string }[] }[];
}
