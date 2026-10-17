import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../packages/store/test/database.ts';
import { objectives } from '../../../policy/objectives.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { lastObserved, reportsFrom } from '../src/logs/cursor.ts';
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

  it('picks up a margin before the last report, after a restart, and leaves no report twice', async () => {
    expect(await lastObserved(database.writer, 'report')).toEqual(new Date('2026-10-03T20:45:00Z'));
    expect(await lastObserved(database.writer, 'probe')).toBeUndefined();
    const from = await reportsFrom(database.writer, NOW, 24 * 60 * 60 * 1000, 10 * 60_000);
    expect(from).toEqual(new Date('2026-10-03T20:35:00Z'));

    // The restarted watcher reads the report at 20:45 again, and the inbox keeps the copy it holds.
    expect(await watcher(from).checkReports(NOW)).toBe(1);
    const [row] = await database.writer<{ reports: number }[]>`
      select count(*)::int as reports from inbox where sense = 'report'`;
    expect(row?.reports).toBe(2);
  });
});

describe('where reading reports starts', () => {
  it('goes back a day for an empty store, and a margin before the last report, but never before the store took real work', async () => {
    const fresh = await freshDatabase('cursor');
    try {
      const now = new Date('2026-10-04T09:00:00Z');
      const day = 24 * 60 * 60 * 1000;
      expect(await reportsFrom(fresh.writer, now, day, 10 * 60_000)).toEqual(new Date('2026-10-03T09:00:00Z'));
      await fresh.owner`insert into store (sample, chosen_at) values (false, '2026-10-04T08:30:00Z')`;
      expect(await reportsFrom(fresh.writer, now, day, 10 * 60_000)).toEqual(new Date('2026-10-04T08:30:00Z'));
      // Nor does the margin before the last report reach back before it.
      await fresh.writer`insert into inbox (id, sense, fingerprint, signal) values (${crypto.randomUUID()}, 'report', null,
        ${fresh.writer.json({ sense: 'report', observedAt: '2026-10-04T08:35:00Z' })})`;
      expect(await reportsFrom(fresh.writer, now, day, 10 * 60_000)).toEqual(new Date('2026-10-04T08:30:00Z'));
    } finally {
      await fresh.end();
    }
  });
});
