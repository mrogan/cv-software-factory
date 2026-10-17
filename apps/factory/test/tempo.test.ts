import { describe, expect, it } from 'vitest';
import { Tempo } from '../src/clients/tempo.ts';
import { TRACES_FROM_THE_APP } from '../src/provenance.ts';

/** A Tempo that answers every request with `body`, and the URLs it was asked. */
function answering(body: unknown) {
  const asked: URL[] = [];
  const tempo = new Tempo('http://tempo', (async (input: URL | string | Request) => {
    asked.push(new URL(String(input)));
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch);
  return { tempo, asked };
}

const route = (path: string, value: number) => ({
  labels: [{ key: 'span.http.route', value: { stringValue: path } }],
  value,
});
const start = new Date('2026-10-17T09:00:00.000Z');
const end = new Date('2026-10-17T09:05:00.000Z');

describe('counting the app’s requests by route in Tempo', () => {
  it('asks Tempo to count the window’s server spans by route, rather than list their traces', async () => {
    const { tempo, asked } = answering({ series: [] });
    await tempo.requestsByRoute('website', start, end, 'abc1234');
    const [url] = asked;
    expect(url?.pathname).toBe('/api/metrics/query');
    expect(url?.searchParams.get('q')).toBe(
      `{ resource.service.name = "website" && ${TRACES_FROM_THE_APP} && resource.service.version = "abc1234" && kind = server && span.http.route != nil } | count_over_time() by (span.http.route)`,
    );
    // To the nanosecond, so that windows meet without overlapping.
    expect(url?.searchParams.get('start')).toBe('1792227600000000000');
    expect(url?.searchParams.get('end')).toBe('1792227900000000000');
    expect(url?.searchParams.has('limit')).toBe(false);
  });

  it('gives each route’s count, however many traces the window holds', async () => {
    const { tempo } = answering({ series: [route('/', 1200), route('/about', 300)], metrics: { completedJobs: 1 } });
    expect(await tempo.requestsByRoute('website', start, end)).toEqual({
      routes: [
        { route: '/', requests: 1200 },
        { route: '/about', requests: 300 },
      ],
      complete: true,
    });
  });

  it('is complete and empty when Tempo has nothing, and leaves out its series', async () => {
    const { tempo } = answering({ metrics: { inspectedBytes: '0', completedJobs: 1, totalJobs: 1 } });
    expect(await tempo.requestsByRoute('website', start, end)).toEqual({ routes: [], complete: true });
  });

  it('counts a series with no value as none', async () => {
    const { tempo } = answering({ series: [{ labels: route('/', 0).labels }] });
    expect(await tempo.requestsByRoute('website', start, end)).toEqual({
      routes: [{ route: '/', requests: 0 }],
      complete: true,
    });
  });

  it('is not complete when Tempo says its answer is partial', async () => {
    const { tempo } = answering({ series: [route('/', 40)], status: 'PARTIAL', message: 'too many series' });
    expect(await tempo.requestsByRoute('website', start, end)).toMatchObject({ complete: false });
  });

  it('refuses an answer that is not a metrics answer', async () => {
    const { tempo } = answering({ series: 'series' });
    await expect(tempo.requestsByRoute('website', start, end)).rejects.toThrow('something else');
  });
});
