/**
 * From a new error pattern to a signal: the lines that show it, the trace ids they link to, and, when Tempo has
 * the trace already, its spans.
 */
import type { InboxSignal } from '@software-factory/events';
import type { LogRecord } from '../clients/loki.ts';
import type { Tempo } from '../clients/tempo.ts';
import type { NewPattern } from './patterns.ts';

/** The lines a signal carries: enough to see the error, and few enough to read. */
const MAX_LINES = 20;
const TRACE_ID = /^[0-9a-f]{32}$/;
const VERSION = /^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/;

/** The level the app's record states, as the evidence's four. */
function levelOf(record: LogRecord): 'debug' | 'info' | 'warn' | 'error' {
  switch (record.fields.detected_level ?? record.fields.severity_text) {
    case 'debug':
    case 'trace':
      return 'debug';
    case 'info':
      return 'info';
    case 'warn':
    case 'warning':
      return 'warn';
    default:
      return 'error';
  }
}

/** The line, with the exception the record attaches to it: the line alone says only that something failed. */
function messageOf(record: LogRecord): string {
  const { exception_type: type, exception_message: message } = record.fields;
  const exception = [type, message].filter(Boolean).join(': ');
  return exception ? `${record.line}: ${exception}` : record.line;
}

/**
 * The signal for a pattern new to the log, or nothing if its records do not say which version of the app wrote
 * them. An error is a `server-error` on the route of the request that raised it, or on every route when no request
 * did: a fair observer says the server failed, and cannot say more.
 */
export async function signalForPattern(found: NewPattern, tempo: Tempo): Promise<InboxSignal | undefined> {
  const records = found.records.slice(-MAX_LINES);
  const latest = records.at(-1);
  const version = latest?.fields.service_version;
  if (!latest || !version || !VERSION.test(version)) return undefined;

  const route = records.find((r) => r.fields.route)?.fields.route;
  const traceId = records.map((r) => r.fields.trace_id).find((id) => id && TRACE_ID.test(id));
  const spans = traceId ? await withinSeconds(3, tempo.spans(traceId)) : undefined;

  return {
    sense: 'logs',
    check: 'new error pattern',
    route: route ?? '*',
    version,
    symptom: 'server-error',
    observedAt: latest.time.toISOString(),
    artifacts: [],
    evidence: [
      {
        kind: 'logs',
        // The evidence names a route, never every route, and never the request's own path, which holds what a
        // visitor typed: when no route served the error, the closest is the root.
        route: route ?? '/',
        version,
        requests: found.records.length,
        lines: records.map((r) => ({
          ts: r.time.toISOString(),
          level: levelOf(r),
          message: messageOf(r).slice(0, 300),
          traceId: TRACE_ID.test(r.fields.trace_id ?? '') ? (r.fields.trace_id ?? null) : null,
        })),
        ...(traceId && spans?.length ? { trace: { id: traceId, spans: spans.slice(0, 20) } } : {}),
      },
    ],
  };
}

/** A promise's answer, or nothing if it takes longer than the time: a signal does not wait for a trace. */
async function withinSeconds<T>(seconds: number, promise: Promise<T>): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), seconds * 1000).unref()),
  ]);
}
