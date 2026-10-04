import type { InboxSignal } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import type { LogRecord } from '../src/clients/loki.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { signalForReport } from '../src/logs/reports.ts';
import { Watcher } from '../src/logs/watcher.ts';
import { printing } from '../src/outbox.ts';
import { fakeFetch, ns, streams, VERSION, vector } from './fakes.ts';

/** What a visitor wrote. Nothing the factory logs, counts or throws may contain it. */
const TEXT = 'The teapot lid will not stay on, ZEBRA-7731 is my order';
const NOW = new Date('2026-10-03T21:00:00Z');

const widgetRecord = (time: string, fields: Record<string, string>): LogRecord => ({
  ns: ns(time),
  time: new Date(time),
  line: 'report',
  fields: { event: 'report', service_version: VERSION, ...fields },
});

describe('a report record becomes a report signal', () => {
  it('carries the page and the text, and the route when it can be told', () => {
    const signal = signalForReport(
      widgetRecord('2026-10-03T20:59:00Z', { page: '/products/teapot-lid', text: TEXT }),
      (page) => (page === '/products/teapot-lid' ? '/products/:slug' : undefined),
    );
    expect(signal).toEqual({
      sense: 'report',
      check: 'report widget',
      route: '/products/:slug',
      version: VERSION,
      observedAt: '2026-10-03T20:59:00.000Z',
      report: { page: '/products/teapot-lid', text: TEXT },
      artifacts: [],
    });
    expect(validateSignal(signal)).toEqual({ ok: true });
  });

  it('is about the page itself when the logs cannot say which route served it', () => {
    const signal = signalForReport(widgetRecord('2026-10-03T20:59:00Z', { page: '/odd', text: TEXT }), () => undefined);
    expect(signal?.route).toBe('/odd');
  });

  it('keeps the page’s path only, because its query is the visitor’s too', () => {
    const signal = signalForReport(
      widgetRecord('2026-10-03T20:59:00Z', { page: '/search?q=my+secret#top', text: TEXT }),
      () => undefined,
    );
    expect(signal?.report?.page).toBe('/search');
  });

  it('reads a record whose body is the JSON of the report', () => {
    const record = {
      ...widgetRecord('2026-10-03T20:59:00Z', {}),
      line: JSON.stringify({ page: '/about', text: TEXT }),
    };
    expect(signalForReport(record, () => undefined)?.report).toEqual({ page: '/about', text: TEXT });
  });

  it('leaves out what it cannot make a signal of: no text, no page, no version', () => {
    const none = () => undefined;
    expect(signalForReport(widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: '  ' }), none)).toBeUndefined();
    expect(signalForReport(widgetRecord('2026-10-03T20:59:00Z', { page: 'about', text: TEXT }), none)).toBeUndefined();
    expect(signalForReport(widgetRecord('2026-10-03T20:59:00Z', { text: TEXT }), none)).toBeUndefined();
    const unversioned = {
      ...widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: TEXT }),
      fields: { page: '/about', text: TEXT },
    };
    expect(signalForReport(unversioned, none)).toBeUndefined();
  });

  it('cuts a very long text to what the inbox accepts', () => {
    const signal = signalForReport(
      widgetRecord('2026-10-03T20:59:00Z', { page: '/about', text: 'x'.repeat(5000) }),
      () => undefined,
    );
    expect(signal?.report?.text).toHaveLength(2000);
    expect(validateSignal(signal)).toEqual({ ok: true });
  });
});

/** A watcher over a fake Loki that holds the given reports, with everything it logs captured. */
function watching(reports: LogRecord[], send: (signal: InboxSignal) => Promise<void>) {
  const logged: string[] = [];
  const loki = fakeFetch([
    {
      path: '/loki/api/v1/query_range',
      when: (url) => (url.searchParams.get('query') ?? '').includes('event="report"'),
      answer: () => streams(...reports.map((r): [string, string, Record<string, string>] => [r.ns, r.line, r.fields])),
    },
    {
      path: '/loki/api/v1/query',
      answer: () => vector([{ path: '/products/teapot-lid', route: '/products/:slug' }, 4]),
    },
  ]);
  const watcher = new Watcher(
    {
      objectives,
      loki: new Loki('http://loki', loki),
      prometheus: new Prometheus('http://prometheus', fakeFetch([])),
      tempo: new Tempo('http://tempo', fakeFetch([])),
      outbox: { send },
      log: pino({ level: 'trace' }, { write: (line: string) => void logged.push(line) }),
    },
    { errors: NOW, reports: new Date('2026-10-03T20:00:00Z') },
  );
  return { watcher, logged };
}

describe('the log watcher and reports', () => {
  const reports = [
    widgetRecord('2026-10-03T20:30:00Z', { page: '/products/teapot-lid', text: TEXT }),
    widgetRecord('2026-10-03T20:45:00Z', { page: '/about', text: `${TEXT} again` }),
  ];

  it('sends each report once, and not again at its next check', async () => {
    const sent: InboxSignal[] = [];
    const { watcher } = watching(reports, async (signal) => void sent.push(signal));
    expect(await watcher.checkReports(NOW)).toBe(2);
    expect(sent.map((s) => s.route)).toEqual(['/products/:slug', '/about']);
    expect(await watcher.checkReports(NOW)).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it('puts the text in the inbox and in no log line the factory writes', async () => {
    const { watcher, logged } = watching(reports, async () => {});
    await watcher.checkReports(NOW);
    await watcher.checkReports(NOW);
    expect(logged.length).toBeGreaterThan(0);
    for (const line of logged) {
      expect(line).not.toContain('teapot lid');
      expect(line).not.toContain('ZEBRA');
      expect(line).not.toContain('/about');
    }
  });

  it('puts the text in no error message when the inbox refuses it, and does not move on', async () => {
    const { watcher, logged } = watching(reports, async (signal) => {
      throw new Error(`The inbox refuses this signal: ${JSON.stringify(signal)}`);
    });
    const failure = await watcher.checkReports(NOW).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('ZEBRA');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure))).not.toContain('ZEBRA');
    expect(logged.join('')).not.toContain('ZEBRA');

    // The next check tries the same report again, rather than losing it.
    const retried: InboxSignal[] = [];
    const again = watching(reports, async (signal) => void retried.push(signal));
    expect(await again.watcher.checkReports(NOW)).toBe(2);
  });

  it('shows a dry run’s report as its length', async () => {
    const lines: string[] = [];
    const { watcher } = watching(reports, (signal) => printing((line) => lines.push(line)).send(signal));
    await watcher.checkReports(NOW);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('ZEBRA');
    expect(JSON.parse(lines[0] ?? '').report).toEqual({
      page: '/products/teapot-lid',
      text: `(${TEXT.length} characters)`,
    });
  });
});
