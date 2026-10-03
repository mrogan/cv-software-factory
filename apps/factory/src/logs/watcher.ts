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
import type { Logger } from 'pino';
import type { Objectives } from '../../../../policy/objectives.ts';
import { quoted } from '../alerts/queries.ts';
import type { Loki } from '../clients/loki.ts';
import type { Prometheus } from '../clients/prometheus.ts';
import type { Tempo } from '../clients/tempo.ts';
import type { Outbox } from '../outbox.ts';
import { routeTemplates } from '../routes.ts';
import { combine, count, judge, type RouteCounts, signalForDisagreement } from './agreement.ts';
import { signalForPattern } from './errors.ts';
import { errorRecords, PatternMemory } from './patterns.ts';
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
}

export const TIMING: Timing = { settleMs: 60_000, agreementWindowMs: 5 * 60_000, agreementLagMs: 4 * 60_000 };

const DAY_MS = 24 * 60 * 60 * 1000;
/** How long before a finding that still holds is signalled again. */
const REPEAT_MS = 60 * 60 * 1000;

/** The selector of the app's error records. */
function errorLogs(o: Objectives): string {
  return `{service_name=${quoted(o.app.logsService)}} | severity_text=~"(?i)error|fatal"`;
}

export class Watcher {
  private readonly patterns = new PatternMemory();
  private errorsFrom: Date;
  /** The last report sent, in Loki's nanoseconds. Records after it are new. */
  private reportCursor: bigint;
  /** The window before the latest, counted. */
  private previousWindow: { start: Date; routes: RouteCounts[] } | undefined;
  /** When each finding was last signalled. */
  private readonly signalledAt = new Map<string, number>();
  private lastWindowEnd = 0;

  private readonly backends: Backends;
  private readonly timing: Timing;

  /** `since` is where each check starts reading: nothing before it has been sent. */
  constructor(backends: Backends, since: { errors: Date; reports: Date }, timing: Timing = TIMING) {
    this.backends = backends;
    this.timing = timing;
    this.errorsFrom = since.errors;
    this.reportCursor = BigInt(since.reports.getTime()) * 1_000_000n;
  }

  /** Learns the error patterns of the day before the watcher starts, so that none of them is new. */
  async learnPatterns(): Promise<number> {
    const { loki, objectives } = this.backends;
    const records = await loki.records(
      errorLogs(objectives),
      new Date(this.errorsFrom.getTime() - DAY_MS),
      this.errorsFrom,
    );
    this.patterns.remember(errorRecords(records));
    return records.length;
  }

  /** Signals each error pattern new to the log among the records written up to `settleMs` ago. */
  async checkErrors(now: Date): Promise<number> {
    const { loki, tempo, outbox, objectives, log } = this.backends;
    const until = new Date(now.getTime() - this.timing.settleMs);
    if (until <= this.errorsFrom) return 0;
    const batch = errorRecords(await loki.records(errorLogs(objectives), this.errorsFrom, until));
    let sent = 0;
    for (const found of this.patterns.fresh(batch)) {
      const signal = await signalForPattern(found, tempo);
      if (!signal) {
        log.warn({ records: found.records.length }, 'a new error pattern has no app version, so it is not signalled');
        continue;
      }
      await outbox.send(signal);
      sent += 1;
    }
    this.patterns.remember(batch);
    this.errorsFrom = until;
    log.info({ errors: batch.length, signals: sent }, 'error patterns checked');
    return sent;
  }

  /** Leaves each report written since the last in the inbox. */
  async checkReports(now: Date): Promise<number> {
    const { loki, outbox, objectives, log } = this.backends;
    const from = new Date(Number(this.reportCursor / 1_000_000n));
    const fresh = (await loki.records(reportLogs(objectives), from, new Date(now.getTime() + 1000))).filter(
      (record) => BigInt(record.ns) > this.reportCursor,
    );
    if (fresh.length === 0) return 0;
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
    const { objectives, loki, prometheus, tempo, outbox, log } = this.backends;
    const end = new Date(now.getTime() - this.timing.agreementLagMs);
    if (end.getTime() - this.lastWindowEnd < this.timing.agreementWindowMs) return 0;
    const start = new Date(end.getTime() - this.timing.agreementWindowMs);
    this.lastWindowEnd = end.getTime();

    let routes: Awaited<ReturnType<typeof count>>['routes'];
    try {
      ({ routes } = await count(objectives, { prometheus, loki, tempo }, start, end));
    } catch (error) {
      // This window is lost, so the next one has no neighbour to be judged with: never pair windows with a gap.
      this.previousWindow = undefined;
      throw error;
    }
    const before = this.previousWindow;
    this.previousWindow = { start, routes };
    if (!before) return 0;

    let wrong = 0;
    let sent = 0;
    for (const entry of combine(before.routes, routes)) {
      const finding = judge(entry);
      if (!finding) continue;
      wrong += 1;
      const key = `${entry.route} ${finding}`;
      const told = this.signalledAt.get(key);
      if (told !== undefined && end.getTime() - told < REPEAT_MS) continue;
      const signal = await signalForDisagreement(finding, entry, { objectives, prometheus }, before.start, end);
      if (!signal) continue;
      await outbox.send(signal);
      this.signalledAt.set(key, end.getTime());
      sent += 1;
    }
    log.info({ routes: routes.length, wrong, signals: sent }, 'agreement checked');
    return sent;
  }
}
