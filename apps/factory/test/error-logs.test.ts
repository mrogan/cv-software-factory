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
  });
});

describe('learning the day’s patterns when the watcher starts', () => {
  const at = new Date('2026-10-17T09:00:00Z');
  /** A page of 5,000 records of one error, then a short page of another, as Loki pages them. */
  const day = (url: URL) => {
    const second = BigInt(url.searchParams.get('start') ?? '0') > BigInt(ns('2026-10-16T09:00:00Z'));
    const line = second ? 'GET /about failed' : 'GET /departments/kitchen failed';
    const count = second ? 3 : 5000;
    const base = Date.parse(second ? '2026-10-17T06:00:00Z' : '2026-10-16T12:00:00Z');
    return streams(
      ...Array.from({ length: count }, (_, i): [string, string, Record<string, string>] => [
        String(BigInt(base + i) * 1_000_000n),
        line,
        { route: second ? '/about' : '/departments/:department', service_version: 'v1.4.2' },
      ]),
    );
  };

  it('reads Loki a page at a time', async () => {
    const loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day }]));
    const sizes: number[] = [];
    for await (const page of loki.pages('{}', new Date(at.getTime() - 86_400_000), at)) sizes.push(page.length);
    expect(sizes).toEqual([5000, 3]);
    expect(await loki.records('{}', new Date(at.getTime() - 86_400_000), at)).toHaveLength(5003);
  });

  it('learns every page’s patterns, so that none of them is new afterwards', async () => {
    const seen: URL[] = [];
    const loki = new Loki('http://loki', fakeFetch([{ path: '/loki/api/v1/query_range', answer: day }], seen));
    const sent: unknown[] = [];
    const outbox = { send: async (signal: unknown) => void sent.push(signal) } as never;
    const tempo = { spans: async () => undefined } as unknown as Tempo;
    const watcher = new Watcher(
      { objectives, loki, tempo, outbox, log: pino({ level: 'silent' }) } as never,
      { errors: at, reports: at },
      { settleMs: 0, agreementWindowMs: 300_000, agreementLagMs: 0 },
    );
    expect(await watcher.learnPatterns()).toBe(5003);
    expect(seen).toHaveLength(2);

    await watcher.checkErrors(new Date(at.getTime() + 60_000));
    expect(sent).toEqual([]);
  });
});
