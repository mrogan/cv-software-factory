/**
 * The log watcher: three checks over what the app has written, each with a cursor of its own so that it does not
 * send again what it has sent. A restart may send a little again, and triage counts repeats.
 *
 * - New error patterns: error records, reduced to patterns, one signal for each the log has not shown in a day.
 * - Reports: the widget's records, each left in the inbox as a `report` signal.
 * - Agreement: per route, whether metrics, logs and traces count the same requests.
 *
 * What a visitor wrote is never logged here, whatever happens: a report's text is handled only by `reports.ts` and
 * the outbox, and nothing in this file logs a record, a page or a signal, only counts and routes the factory knows.
 */
import type { InboxSignal } from '@software-factory/events';
import type { Logger } from 'pino';
import type { Objectives } from '../../../../policy/objectives.ts';
import { quoted } from '../alerts/queries.ts';
import type { Loki } from '../clients/loki.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import type { Tempo } from '../clients/tempo.ts';
import type { Outbox } from '../outbox.ts';
import { LOGS_FROM_THE_APP } from '../provenance.ts';
import { routeTemplates } from '../routes.ts';
import {
  combine,
  count,
  judge,
  logSilent,
  type RouteCounts,
  signalForDisagreement,
  signalForSilentLog,
} from './agreement.ts';
import { MAX_LINES, signalForPattern } from './errors.ts';
import { errorRecords, freshInPage, type NewPattern, PatternMemory } from './patterns.ts';
import { reportLogs, signalForReport } from './reports.ts';

export interface Backends {
  objectives: Objectives;
  loki: Loki;
  prometheus: Prometheus;
  tempo: Tempo;
  outbox: Outbox;
  log: Logger;
}

export interface Timing {
  /** An error record is read this long after it was written, so that its trace has had time to reach Tempo. */
  settleMs: number;
  /** Agreement is judged over a window of this length... */
  agreementWindowMs: number;
  /** ...that ended this long ago, for the same reason. */
  agreementLagMs: number;
  /**
   * How long after it was written a report may still reach Loki and be read: the collector retries a failed export
   * for up to five minutes, and this leaves room beyond that for the batching and ingest on either side. A check that
   * finds nothing new starts the next no later than this long ago.
   */
  reportLateMs: number;
}

export const TIMING: Timing = {
  settleMs: 60_000,
  agreementWindowMs: 5 * 60_000,
  agreementLagMs: 4 * 60_000,
  reportLateMs: 10 * 60_000,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long before a finding that still holds is signalled again. */
const REPEAT_MS = 60 * 60 * 1000;
/** How often the agreement check asks the last day's log for the route of each path. */
const ROUTES_REFRESH_MS = 60 * 60 * 1000;

/**
 * The fields of an error record that its readers use: the pattern (`patterns.ts`), the signal and its kept lines
 * (`errors.ts`), and Verify's filters. Loki returns these and no others: a record's other metadata, a stack trace of
 * a kilobyte or more among it, is most of its size and read by nothing. A reader of another field adds it here.
 */
export const ERROR_FIELDS = [
  'route',
  'path',
  'exception_type',
  'exception_message',
  'service_version',
  'trace_id',
  'severity_text',
  'detected_level',
] as const;

/**
 * The app's error records, with only the fields their readers use. `where` narrows them with further filters, which
 * come before the fields are cut, so that they may name any field.
 */
export function errorLogs(o: Objectives, where = ''): string {
  const selector = `{service_name=${quoted(o.app.logsService)}, ${LOGS_FROM_THE_APP}}`;
  return `${selector} | severity_text=~"(?i)error|fatal"${where} | keep ${ERROR_FIELDS.join(', ')}`;
}

export class Watcher {
  private patterns = new PatternMemory();
  private errorsFrom: Date;
  /**
   * Where reading reports starts, in Loki's nanoseconds: the last report sent, or, after a check that found none,
   * `reportLateMs` before it. Records after it are new.
   */
  private reportCursor: bigint;
  /** The window before the latest, counted. */
  private previousWindow: { start: Date; routes: RouteCounts[] } | undefined;
  /** When each finding was last signalled. */
  private readonly signalledAt = new Map<string, number>();
  private lastWindowEnd = 0;
  /**
   * The route the log last gave each path, kept between windows, so that a window with no log records still places
   * the paths the log has named before: through a gap longer than the lookup's day, or a lookup that failed.
   */
  private readonly routeNames = new Map<string, string>();
  private routeNamesAt = Number.NEGATIVE_INFINITY;

  private readonly backends: Backends;
  private readonly timing: Timing;

  /** `since` is where each check starts reading: nothing before it has been sent. */
  constructor(backends: Backends, since: { errors: Date; reports: Date }, timing: Timing = TIMING) {
    this.backends = backends;
    this.timing = timing;
    this.errorsFrom = since.errors;
    this.reportCursor = BigInt(since.reports.getTime()) * 1_000_000n;
  }

  /**
   * Learns the error patterns of the day before the watcher starts, so that none of them is new: every record of the
   * day, a page at a time, so that what the watcher holds stays one page however many errors the app logged, and the
   * hours just before it starts are learned however busy the day.
   */
  async learnPatterns(): Promise<number> {
    const { loki, objectives } = this.backends;
    const from = new Date(this.errorsFrom.getTime() - DAY_MS);
    let learned = 0;
    for await (const page of loki.pages(errorLogs(objectives), from, this.errorsFrom, Number.POSITIVE_INFINITY)) {
      this.patterns.remember(errorRecords(page));
      learned += page.length;
    }
    return learned;
  }

  /**
   * Signals each error pattern new to the log among the records written up to `settleMs` ago: every one of them, read
   * a page at a time, however long the window since the last check.
   */
  async checkErrors(now: Date): Promise<number> {
    const { loki, tempo, outbox, objectives, log } = this.backends;
    const until = new Date(now.getTime() - this.timing.settleMs);
    if (until <= this.errorsFrom) return 0;
    // Every record, a page at a time, remembered in a copy of the memory that becomes it only once every signal has
    // been sent: a send that failed leaves the patterns new, and the window is read again next time.
    const memory = this.patterns.copy();
    const found = new Map<string, NewPattern>();
    let errors = 0;
    for await (const page of loki.pages(errorLogs(objectives), this.errorsFrom, until, Number.POSITIVE_INFINITY)) {
      freshInPage(memory, found, errorRecords(page), MAX_LINES);
      errors += page.length;
    }
    let sent = 0;
    for (const pattern of found.values()) {
      const signal = await signalForPattern(pattern, tempo);
      if (!signal) {
        log.warn({ records: pattern.count }, 'a new error pattern has no app version, so it is not signalled');
        continue;
      }
      await outbox.send(signal);
      sent += 1;
    }
    this.patterns = memory;
    this.errorsFrom = until;
    log.info({ errors, signals: sent }, 'error patterns checked');
    return sent;
  }

  /**
   * Leaves each report written since the last in the inbox. A check that finds none moves the cursor up to
   * `reportLateMs` ago, so that the window read every few seconds stays short while no visitor writes, and a report
   * that reaches Loki late, but within that, is still in it.
   */
  async checkReports(now: Date): Promise<number> {
    const { loki, outbox, objectives, log } = this.backends;
    const from = new Date(Number(this.reportCursor / 1_000_000n));
    const fresh = (await loki.records(reportLogs(objectives), from, new Date(now.getTime() + 1000))).filter(
      (record) => BigInt(record.ns) > this.reportCursor,
    );
    if (fresh.length === 0) {
      const settled = BigInt(now.getTime() - this.timing.reportLateMs) * 1_000_000n;
      if (settled > this.reportCursor) this.reportCursor = settled;
      return 0;
    }
    // Where the app's logs can place a page, the report is about that route; the lookup never blocks a report.
    const templates = await routeTemplates(loki, objectives, now).catch(() => new Map<string, string>());
    let sent = 0;
    let skipped = 0;
    for (const record of fresh) {
      const signal = signalForReport(record, (page) => templates.get(page));
      if (signal) {
        try {
          await outbox.send(signal);
        } catch {
          // Not the cause: a refusal can quote the signal, and the signal holds the visitor's words.
          throw new Error('A report could not be left in the inbox');
        }
        sent += 1;
      } else {
        skipped += 1;
      }
      this.reportCursor = BigInt(record.ns);
    }
    log.info({ reports: sent, unreadable: skipped }, 'reports checked');
    return sent;
  }

  /**
   * Judges the window that ended `agreementLagMs` ago, if it is a new one, together with the window before it, and
   * signals each route found wrong. Call it as often as you like: it judges each window once.
   *
   * Two windows together, because the metrics are a minute or so behind the log: a burst of requests at the edge of
   * a window is counted by the log in this window and by the metrics in the next, and each window alone would say
   * the metrics are wrong. Over both, the burst is in the same place for every record. A finding is signalled once
   * an hour while it holds, as Alertmanager repeats an alert.
   */
  async checkAgreement(now: Date): Promise<number> {
    const { objectives, loki, prometheus, tempo, log } = this.backends;
    const end = new Date(now.getTime() - this.timing.agreementLagMs);
    if (end.getTime() - this.lastWindowEnd < this.timing.agreementWindowMs) return 0;
    const start = new Date(end.getTime() - this.timing.agreementWindowMs);
    this.lastWindowEnd = end.getTime();

    await this.refreshRouteNames(end);
    let routes: Awaited<ReturnType<typeof count>>['routes'];
    try {
      ({ routes } = await count(objectives, { prometheus, loki, tempo }, start, end, this.routeNames));
    } catch (error) {
      // This window is lost, so the next one has no neighbour to be judged with: never pair windows with a gap.
      this.previousWindow = undefined;
      throw error;
    }
    for (const entry of routes) if (entry.route !== entry.path) this.routeNames.set(entry.path, entry.route);
    const before = this.previousWindow;
    this.previousWindow = { start, routes };
    if (!before) return 0;

    const both = combine(before.routes, routes);
    // A log silent for every route is one finding about the log, not one for each route that had requests. A pair
    // with one window silent is the edge of the same gap: over both, every route would seem to have lost some of its
    // records, and each would be a finding of its own.
    if (logSilent(both) || logSilent(before.routes) || logSilent(routes)) {
      const sent = (await this.tell('* missing-log', end, async () => signalForSilentLog(both, end))) ? 1 : 0;
      log.info({ routes: routes.length, signals: sent }, 'agreement checked: the log is silent for every route');
      return sent;
    }
    let wrong = 0;
    let sent = 0;
    for (const entry of both) {
      const finding = judge(entry);
      if (!finding) continue;
      wrong += 1;
      const told = await this.tell(`${entry.route} ${finding}`, end, () =>
        signalForDisagreement(finding, entry, { objectives, prometheus }, before.start, end),
      );
      if (told) sent += 1;
    }
    log.info({ routes: routes.length, wrong, signals: sent }, 'agreement checked');
    return sent;
  }

  /** Sends a finding's signal, unless it was sent within the hour or there is none. Says whether it was sent. */
  private async tell(key: string, end: Date, signal: () => Promise<InboxSignal | undefined>): Promise<boolean> {
    const told = this.signalledAt.get(key);
    if (told !== undefined && end.getTime() - told < REPEAT_MS) return false;
    const made = await signal();
    if (!made) return false;
    await this.backends.outbox.send(made);
    this.signalledAt.set(key, end.getTime());
    return true;
  }

  /**
   * Asks the last day's log for the route of each path, at most once an hour, and adds what it says to the names
   * known before. A lookup that failed, or found nothing, leaves them as they were until the next hour: a log silent
   * for a day has nothing more to say, and the query is a heavy one.
   */
  private async refreshRouteNames(end: Date): Promise<void> {
    if (end.getTime() - this.routeNamesAt < ROUTES_REFRESH_MS) return;
    this.routeNamesAt = end.getTime();
    const { loki, objectives, log } = this.backends;
    try {
      const fresh = await routeTemplates(loki, objectives, end);
      for (const [path, route] of fresh) if (route !== path) this.routeNames.set(path, route);
    } catch (error) {
      log.warn({ err: error }, 'the routes of the last day’s paths could not be looked up; the names known are kept');
    }
  }
}
