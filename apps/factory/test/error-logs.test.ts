import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import { type LogRecord, Loki } from '../src/clients/loki.ts';
import type { Tempo } from '../src/clients/tempo.ts';
import { keptLine, signalForPattern } from '../src/logs/errors.ts';
import { errorRecords, sameError } from '../src/logs/patterns.ts';
import { ERROR_FIELDS, errorLogs, Watcher } from '../src/logs/watcher.ts';
import { fakeFetch, ns, streams } from './fakes.ts';

/** An error record with the metadata the collector gives one, a stack trace among it. */
const everything: Record<string, string> = {
  service_name: 'website',
  service_namespace: 'website',
  service_version: 'v1.4.2',
  route: '/departments/:department',
  path: '/departments/kitchen',
  method: 'GET',
  event: 'request failed',
  exception_type: 'TypeError',
  exception_message: 'no "slug" on 42',
  exception_stacktrace: `TypeError: no "slug" on 42\n${'    at render (/app/server.js:120:7)\n'.repeat(40)}`,
  trace_id: '0af7651916cd43dd8448eb211c80319c',
  span_id: 'b7ad6b7169203331',
  severity_text: 'ERROR',
  severity_number: '17',
  detected_level: 'error',
  k8s_pod_name: 'website-6d9f7c-abcde',
  process_command_args: '["node","server.js"]',
};

const record = (fields: Record<string, string>): LogRecord => ({
  ns: ns('2026-10-17T08:00:00Z'),
  time: new Date('2026-10-17T08:00:00Z'),
  line: 'GET /departments/kitchen failed',
  fields,
});

/** The record as Loki gives it under `keep`: its fields cut to those named. */
const kept = (fields: Record<string, string>) =>
  Object.fromEntries(Object.entries(fields).filter(([name]) => (ERROR_FIELDS as readonly string[]).includes(name)));

describe('the error records Loki is asked for', () => {
  it('carry only the fields their readers use, narrowed first by any filter', () => {
    const query = errorLogs(objectives, ' | route="/about"');
    expect(query).toMatch(/\| route="\/about" \| keep route, path, [a-z_, ]+$/);
    expect(errorLogs(objectives)).toMatch(/\| severity_text=~"\(\?i\)error\|fatal" \| keep /);
  });

  it('are read the same with only those fields as with all of them', async () => {
    const whole = record(everything);
    const cut = record(kept(everything));
    expect(Object.keys(cut.fields).length).toBeLessThan(Object.keys(whole.fields).length);

    expect(errorRecords([cut])[0]?.pattern).toBe(errorRecords([whole])[0]?.pattern);
    expect(keptLine(cut)).toEqual(keptLine(whole));
    const line = 'GET /departments/garden failed: TypeError: no "slug" on 7';
    expect(sameError(cut, keptLine(cut).message, line, everything.route ?? '')).toBe(true);

    const tempo = { spans: async () => undefined } as unknown as Tempo;
    const signal = async (r: LogRecord) => signalForPattern({ pattern: 'p', records: [r] }, tempo);
    expect(await signal(cut)).toEqual(await signal(whole));

    // A record with no exception is told by its line, its path put back to its route, and its level by its severity.
    const { exception_type, exception_message, exception_stacktrace, detected_level, ...plain } = everything;
    const bare = record({ ...plain, severity_text: 'warn' });
    const bareCut = record(kept(bare.fields));
    expect(errorRecords([bareCut])[0]?.pattern).toBe('/departments/:department GET /departments/:department failed');
    expect(keptLine(bareCut)).toEqual(keptLine(bare));
    expect(keptLine(bareCut).level).toBe('warn');
    expect(await signal(bareCut)).toEqual(await signal(bare));
  });
});

describe('learning the day’s patterns when the watcher starts', () => {
  const at = new Date('2026-10-17T09:00:00Z');
  /**
   * A day as Loki pages it: `full` pages of 5,000 records of one error, a millisecond apart from where each is asked
   * to start, then a short page of another error, three hours before the watcher starts.
   */
  const day = (full: number) => {
    let asked = 0;
    return (url: URL) => {
      const last = asked++ >= full;
      const start = Number(BigInt(url.searchParams.get('start') ?? '0') / 1_000_000n);
      const base = last ? Date.parse('2026-10-17T06:00:00Z') : start + 1;
      return streams(
        ...Array.from({ length: last ? 3 : 5000 }, (_, i): [string, string, Record<string, string>] => [
          String(BigInt(base + i) * 1_000_000n),
          last ? 'GET /about failed' : 'GET /departments/kitchen failed',
          { route: last ? '/about' : '/departments/:department', service_version: 'v1.4.2' },
        ]),
      );
    };
  };

  it('reads Loki a page at a time', async () => {
    const loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day(1) }]));
    const sizes: number[] = [];
    for await (const page of loki.pages('{}', new Date(at.getTime() - 86_400_000), at)) sizes.push(page.length);
    expect(sizes).toEqual([5000, 3]);
    const again = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day(1) }]));
    expect(await again.records('{}', new Date(at.getTime() - 86_400_000), at)).toHaveLength(5003);
  });

  it('learns every page’s patterns, however many, so that none of them is new afterwards', async () => {
    const seen: URL[] = [];
    const loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day(5) }], seen));
    const sent: unknown[] = [];
    const outbox = { send: async (signal: unknown) => void sent.push(signal) } as never;
    const tempo = { spans: async () => undefined } as unknown as Tempo;
    const watcher = new Watcher(
      { objectives, loki, tempo, outbox, log: pino({ level: 'silent' }) } as never,
      { errors: at, reports: at },
      { settleMs: 0, agreementWindowMs: 300_000, agreementLagMs: 0 },
    );
    // More than the 20,000 records a read stops at otherwise: the last hours before the start are learned too.
    expect(await watcher.learnPatterns()).toBe(25_003);
    expect(seen).toHaveLength(6);

    await watcher.checkErrors(new Date(at.getTime() + 60_000));
    expect(sent).toEqual([]);
  });
});
