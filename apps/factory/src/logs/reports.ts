/**
 * Reports. A visitor's report is one structured log record from the app (spec section 3): the app holds no
 * credential and does not know the factory exists. The watcher reads those records from Loki and leaves each in the
 * inbox as a `report` signal, where only triage reads it.
 *
 * What a report's text touches is kept to one path: the record, then the signal. It is never logged, counted,
 * made a metric label or put in an error message, here or by the callers that handle what this returns.
 *
 * The widget's record has not been seen yet (no visitor has used it on the cluster this was written against), so
 * the shape is the one a structured report would have: `event` is `report`, `page` is the path the visitor was on,
 * and `text` is what they wrote, each a field of the record. A record whose JSON body holds `page` and `text` is
 * read the same way.
 */
import { cutTo, type InboxSignal } from '@software-factory/events';
import { uuidFrom } from '@software-factory/triage/events';
import type { Objectives } from '../../../../policy/objectives.ts';
import { quoted } from '../alerts/queries.ts';
import type { LogRecord } from '../clients/loki.ts';
import { LOGS_FROM_THE_APP } from '../provenance.ts';

/** The selector of the widget's records. */
export function reportLogs(o: Objectives): string {
  return `{service_name=${quoted(o.app.logsService)}, ${LOGS_FROM_THE_APP}} | event="report"`;
}

const MAX_TEXT = 2000;
const VERSION = /^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/;

interface Fields {
  page?: unknown;
  text?: unknown;
}

function fieldsOf(record: LogRecord): Fields {
  if (record.fields.page !== undefined || record.fields.text !== undefined) return record.fields;
  try {
    const body: unknown = JSON.parse(record.line);
    return body && typeof body === 'object' ? (body as Fields) : {};
  } catch {
    return {};
  }
}

/**
 * The signal for a report record, or nothing when it has no text, no page or no version. `routeOf` says which route
 * handled the page, when the app's logs can tell; otherwise the route is the page itself.
 */
export function signalForReport(
  record: LogRecord,
  routeOf: (page: string) => string | undefined,
): InboxSignal | undefined {
  const { page: rawPage, text: rawText } = fieldsOf(record);
  const text = typeof rawText === 'string' ? cutTo(rawText.trim(), MAX_TEXT) : '';
  // The page's path only: its query string is the visitor's too.
  const page = typeof rawPage === 'string' ? (rawPage.split(/[?#]/)[0] ?? '') : '';
  const version = record.fields.service_version;
  if (!text || !page.startsWith('/') || /\s/.test(page) || page.length > 200 || !version || !VERSION.test(version)) {
    return undefined;
  }
  return {
    sense: 'report',
    check: 'report widget',
    route: routeOf(page) ?? page,
    version,
    observedAt: record.time.toISOString(),
    report: { page, text },
    artifacts: [],
  };
}

/**
 * The inbox id of a report record's signal, the same however often the record is read: a UUID from its time, its
 * line, and the report's own fields, and not from the labels Loki adds, which an upgrade may change. The inbox keeps
 * the first signal with an id and drops any sent again with it, so a report read twice, by a check that reads back
 * over its margin or by a watcher that restarted, is left there once.
 */
export function reportSignalId(record: LogRecord): string {
  const { page, text, service_version } = record.fields;
  return uuidFrom(`report:${JSON.stringify([record.ns, record.line, page, text, service_version])}`);
}
