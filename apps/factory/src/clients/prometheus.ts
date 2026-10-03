/** Prometheus's HTTP API, for the two questions the factory asks it: a value now, and a series over a range. */
import { type Fetch, getJson, type Sample, samplesOf, toNumber } from './http.ts';

/** A series sampled at a fixed step: `values[i]` is the value at `start + i * stepSeconds`, null where it had none. */
export interface Series {
  start: Date;
  stepSeconds: number;
  values: (number | null)[];
}

export class Prometheus {
  private readonly base: string;
  private readonly fetcher: Fetch;

  constructor(base: string, fetcher: Fetch = fetch) {
    this.base = base;
    this.fetcher = fetcher;
  }

  async instant(query: string, at?: Date): Promise<Sample[]> {
    const params: Record<string, string | number> = { query };
    if (at) params.time = at.getTime() / 1000;
    return samplesOf(await getJson(this.fetcher, this.base, '/api/v1/query', params));
  }

  /** The first series of a query that has one, on the grid from `start` to `end`, or nothing when it has none. */
  async range(query: string, start: Date, end: Date, stepSeconds: number): Promise<Series | undefined> {
    const answer = (await getJson(this.fetcher, this.base, '/api/v1/query_range', {
      query,
      start: start.getTime() / 1000,
      end: end.getTime() / 1000,
      step: stepSeconds,
    })) as { data?: { result?: { values?: [number, string][] }[] } };
    const points = answer.data?.result?.[0]?.values;
    if (!points) return undefined;
    const startSeconds = start.getTime() / 1000;
    const count = Math.floor((end.getTime() - start.getTime()) / 1000 / stepSeconds) + 1;
    const values = new Array<number | null>(count).fill(null);
    for (const [time, text] of points) {
      const index = Math.round((time - startSeconds) / stepSeconds);
      if (index >= 0 && index < count) values[index] = toNumber(text);
    }
    return { start, stepSeconds, values };
  }
}
