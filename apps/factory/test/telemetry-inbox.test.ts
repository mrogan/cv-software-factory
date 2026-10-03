import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { objectives } from '../../../policy/objectives.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { lastObserved } from '../src/logs/cursor.ts';
import { Watcher } from '../src/logs/watcher.ts';
import { inbox } from '../src/outbox.ts';
import { fakeFetch, ns, streams, VERSION, vector } from './fakes.ts';

/** The telemetry senses' signals, left in a real inbox. */
let database: Database;

beforeAll(async () => {
  database = await freshDatabase('telemetry');
});
afterAll(() => database?.end());

const NOW = new Date('2026-10-03T21:00:00Z');

function watcher(since: Date) {
  const loki = fakeFetch([
    {
      path: '/loki/api/v1/query_range',
      when: (url) => (url.searchParams.get('query') ?? '').includes('event="report"'),
      answer: () =>
        streams(
          [
            ns('2026-10-03T20:30:00Z'),
            'report',
            { event: 'report', page: '/about', text: 'The about page has no about', service_version: VERSION },
          ],
          [
            ns('2026-10-03T20:45:00Z'),
            'report',
            { event: 'report', page: '/products/teapot-lid', text: 'The lid is missing', service_version: VERSION },
          ],
        ),
    },
    {
      path: '/loki/api/v1/query_range',
      when: (url) => (url.searchParams.get('query') ?? '').includes('severity_text'),
      answer: () =>
        streams([
          ns('2026-10-03T20:40:00Z'),
          'GET /search failed',
          {
            route: '/search',
            path: '/search',
            service_version: VERSION,
            severity_text: 'error',
            exception_type: 'URIError',
            exception_message: 'URI malformed',
            trace_id: '9b1379cfdb0eace529f860d37eda3718',
          },
        ]),
    },
    { path: '/loki/api/v1/query', answer: () => vector() },
  ]);
  return new Watcher(
    {
      objectives,
      loki: new Loki('http://loki', loki),
      prometheus: new Prometheus('http://prometheus', fakeFetch([])),
      tempo: new Tempo(
        'http://tempo',
        fakeFetch([{ path: '/api/traces/9b1379cfdb0eace529f860d37eda3718', answer: () => ({}) }]),
      ),
      outbox: inbox(database.writer),
      log: pino({ level: 'silent' }),
    },
    { errors: since, reports: since },
  );
}

describe('the log watcher, against a real inbox', () => {
  it('leaves reports and new error patterns where triage will find them', async () => {
    const watching = watcher(new Date('2026-10-03T20:00:00Z'));
    expect(await watching.checkReports(NOW)).toBe(2);
    expect(await watching.checkErrors(NOW)).toBe(1);

    const rows = await database.writer<
      { sense: string; fingerprint: string | null; signal: { report?: { text: string } } }[]
    >`
      select sense, fingerprint, signal from inbox order by sense, received_at`;
    expect(rows.map((r) => [r.sense, r.fingerprint])).toEqual([
      ['logs', '/search server-error'],
      ['report', null],
      ['report', null],
    ]);
    expect(rows.filter((r) => r.sense === 'report').map((r) => r.signal.report?.text)).toEqual([
      'The about page has no about',
      'The lid is missing',
    ]);
  });

  it('picks up where the last report left off, after a restart', async () => {
    expect(await lastObserved(database.writer, 'report')).toEqual(new Date('2026-10-03T20:45:00Z'));
    expect(await lastObserved(database.writer, 'probe')).toBeUndefined();
  });
});
