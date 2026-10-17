/**
 * Tempo's HTTP API. A trace is not queryable until a minute or two after its spans are sent, so every
 * caller treats "not there yet" as an answer and never waits for one.
 */
import { APP_POD_ATTRIBUTE, TRACES_FROM_THE_APP } from '../provenance.ts';
import { type Fetch, getJson } from './http.ts';

/** How many of the app's requests one route served, as its server spans count them. */
export interface RouteRequests {
  /** The `http.route` of the requests: the path asked for. */
  route: string;
  requests: number;
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
   * The app's requests between two times, route by route, of one version of it when one is named: its server spans
   * with a route, counted by Tempo (a TraceQL metrics query) rather than listed, so that the count does not stop at a
   * page of traces. Only spans the collector stamped as from the app's pods count (provenance.ts). `complete` is false
   * when Tempo says its answer is partial.
   */
  async requestsByRoute(
    service: string,
    start: Date,
    end: Date,
    version?: string,
  ): Promise<{ routes: RouteRequests[]; complete: boolean }> {
    const ofVersion = version === undefined ? '' : ` && resource.service.version = ${JSON.stringify(version)}`;
    const answer = (await getJson(
      this.fetcher,
      this.base,
      '/api/metrics/query',
      {
        q: `{ resource.service.name = ${JSON.stringify(service)} && ${TRACES_FROM_THE_APP}${ofVersion} && kind = server && span.http.route != nil } | count_over_time() by (span.http.route)`,
        start: Math.floor(start.getTime() / 1000),
        end: Math.ceil(end.getTime() / 1000),
      },
      20_000,
    )) as { series?: { labels?: Attribute[]; value?: number }[]; status?: string | number };
    // Tempo leaves the series out when there are none.
    if (answer.series !== undefined && !Array.isArray(answer.series)) {
      throw new Error('Tempo answered a metrics query with something else');
    }
    const routes = (answer.series ?? []).flatMap((series) => {
      const route = series.labels?.find((a) => a.key === 'span.http.route')?.value.stringValue;
      const requests = Number(series.value);
      return route && Number.isFinite(requests) ? [{ route, requests }] : [];
    });
    // A partial answer is one some of Tempo's jobs did not finish (`PARTIAL`, or its number in the enum).
    return { routes, complete: answer.status !== 'PARTIAL' && answer.status !== 1 };
  }

  /** Whether Tempo has any trace, from anything, that began between two times. */
  async anyTrace(start: Date, end: Date): Promise<boolean> {
    const answer = (await getJson(this.fetcher, this.base, '/api/search', {
      q: '{}',
      start: Math.floor(start.getTime() / 1000),
      end: Math.ceil(end.getTime() / 1000),
      limit: 1,
    })) as { traces?: unknown };
    if (answer.traces === undefined) return false;
    if (!Array.isArray(answer.traces)) throw new Error('Tempo answered a search with something else');
    return answer.traces.length > 0;
  }

  /**
   * The app's spans of a trace, in the order they began, or nothing if Tempo does not have them yet. A trace id is
   * anyone's to send, so only the spans whose resource the collector stamped as the app's are kept (provenance.ts).
   */
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
    const raw = (answer.batches ?? answer.trace?.resourceSpans ?? [])
      .filter((batch) => batch.resource?.attributes?.some((a) => a.key === APP_POD_ATTRIBUTE && a.value.stringValue))
      .flatMap((batch) => (batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []));
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
  resource?: { attributes?: Attribute[] };
  scopeSpans?: { spans?: { name: string; startTimeUnixNano: string; endTimeUnixNano: string }[] }[];
}
