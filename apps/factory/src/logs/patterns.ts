/**
 * New error patterns. Two errors that differ only in a number, an identifier or a quoted value are one error, so
 * each message is reduced to a pattern, and a pattern the log has not shown in the previous day is news.
 */
import { cutAt } from '@software-factory/events';
import { templatePattern } from '../alerts/queries.ts';
import type { LogRecord } from '../clients/loki.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Takes out of a message whatever changes from one occurrence to the next, leaving the words an engineer would
 * search for. Most specific first: a quoted value may hold a number, and a UUID is made of digits.
 */
const REDUCTIONS: [RegExp, string][] = [
  [/"[^"]*"|'[^']*'|`[^`]*`/g, '<value>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  // A date, or a date and time: 2026-10-03, 2026-10-03T20:42:56.123Z.
  [/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?)?\b/g, '<time>'],
  // At least one digit and one letter, so that "effaced" stays a word and a long number stays a number.
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, '<hash>'],
  // A token that mixes letters and digits, such as order-9x2f or v2.0.1: an identifier.
  [/\b(?=[\w-]*[a-z_])[\w-]*\d[\w-]*(?:[.:]\w+)*\b/gi, '<id>'],
  [/\b\d+(?:[.:/-]\d+)*\b/g, '<n>'],
  [/\s+/g, ' '],
];

export function reduce(message: string): string {
  return REDUCTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message).trim();
}

/**
 * A line a signal kept (`errors.ts`), or a record's line written the same way, as a pattern to compare: what a path of
 * the route's put in it is put back to the route, as `describe` does with a record's own path, and the rest reduced.
 * A signal keeps the lines and not the pattern, and its lines name the paths visitors asked for, which differ from one
 * request to the next. Both sides are cut as the evidence cuts a line before they are compared.
 */
export function keptPattern(kept: string, route: string): string {
  // A line was cut before its paths were put back, at a place that moves with the path's length: only the start of
  // the pattern is compared, short of where any cut could fall.
  return cutAt(withRoute(kept, route), KEPT_COMPARED);
}

/** A kept line, its paths put back to the route, reduced: whole. */
function withRoute(kept: string, route: string): string {
  const paths = route !== '*' && route.includes(':') && new RegExp(templatePattern(route, '[^/\\s"\'?#:]+'), 'g');
  return reduce(paths ? kept.replace(paths, route) : kept);
}

/** How much of a kept line's pattern is compared: well short of where the evidence cuts a line (`MAX_MESSAGE`). */
const KEPT_COMPARED = 200;

/**
 * Whether an error record shows the error a kept line showed, as the watcher would have grouped them. Where the record
 * attaches an exception, the watcher's pattern is the exception alone (`describe`), whatever the line before it said,
 * so the record matches a kept line that carries the same exception; otherwise their whole lines are compared, as
 * `keptPattern` puts them. `line` is the record as the evidence keeps it (`keptLine`).
 */
export function sameError(record: LogRecord, line: string, kept: string, route: string): boolean {
  if (keptPattern(line, route) === keptPattern(kept, route)) return true;
  const { exception_type: type, exception_message: message } = record.fields;
  if (!type && !message) return false;
  // The kept line is the record's line, then `: ` and the exception, cut: the exception's start is in it.
  return withRoute(kept, route).includes(cutAt(reduce(describe(record)), EXCEPTION_COMPARED));
}

/** How much of an exception's pattern must be in a kept line: what survives the cut of most lines. */
const EXCEPTION_COMPARED = 100;

/** An error record, with what the patterns and the signal need from it. */
export interface ErrorRecord {
  record: LogRecord;
  pattern: string;
}

/**
 * What an error record says went wrong. An app that logs an error as "GET /x failed" says what failed in the
 * exception it attaches (OpenTelemetry's `exception.type` and `exception.message`, which Loki shows as
 * `exception_type` and `exception_message`), so that is what two errors are compared by when it is there. The line
 * is compared otherwise, with the request's own path replaced by its route, as one route's errors are the same
 * whichever product they were for.
 */
export function describe(record: LogRecord): string {
  const { exception_type: type, exception_message: message, path, route } = record.fields;
  if (type || message) return [type, message].filter(Boolean).join(': ');
  return path ? record.line.replaceAll(path, route || '<path>') : record.line;
}

/**
 * Each record with its pattern. The same error on another route is another finding (a ticket is for a route and a
 * symptom), so the route is part of the pattern; an error no request raised belongs to `*`.
 */
export function errorRecords(records: LogRecord[]): ErrorRecord[] {
  return records.map((record) => ({
    record,
    pattern: `${record.fields.route || '*'} ${reduce(describe(record))}`,
  }));
}

/** A pattern new to the log, with the records that show it in the batch, or the last of them, and how many there are. */
export interface NewPattern {
  pattern: string;
  records: LogRecord[];
  count: number;
}

/** Remembers when each pattern was last seen, and says which of a batch are new. */
export class PatternMemory {
  private readonly lastSeen = new Map<string, number>();
  private readonly memoryMs: number;

  constructor(memoryMs = DAY_MS) {
    this.memoryMs = memoryMs;
  }

  /** The patterns of a batch that were not seen in the memory's span before the batch's first record of them. */
  fresh(batch: ErrorRecord[]): NewPattern[] {
    const found = new Map<string, NewPattern>();
    const seen = new Map(this.lastSeen);
    for (const { record, pattern } of batch) {
      const before = seen.get(pattern);
      const isNew = before === undefined || record.time.getTime() - before > this.memoryMs;
      seen.set(pattern, record.time.getTime());
      if (isNew && !found.has(pattern)) found.set(pattern, { pattern, records: [], count: 0 });
      const entry = found.get(pattern);
      if (entry) {
        entry.records.push(record);
        entry.count += 1;
      }
    }
    return [...found.values()];
  }

  /** A memory of its own that starts as this one does, to remember a batch in before the batch is dealt with. */
  copy(): PatternMemory {
    const copy = new PatternMemory(this.memoryMs);
    for (const [pattern, at] of this.lastSeen) copy.lastSeen.set(pattern, at);
    return copy;
  }

  /** Notes that the batch has been dealt with, so its patterns are no longer new. */
  remember(batch: ErrorRecord[]): void {
    for (const { record, pattern } of batch) {
      this.lastSeen.set(pattern, Math.max(this.lastSeen.get(pattern) ?? 0, record.time.getTime()));
    }
  }
}

/**
 * Adds a page of a batch to the patterns new in the batch so far (`found`), and remembers the page in `memory`, so
 * that read a page at a time, a batch's new patterns are those `fresh` finds in the whole batch at once: a pattern new
 * on one page gathers its records on the pages after. Only the last `keep` records of each are kept, with the count of
 * them all, so that what is held is a page and no more however long the batch.
 */
export function freshInPage(
  memory: PatternMemory,
  found: Map<string, NewPattern>,
  page: ErrorRecord[],
  keep: number,
): void {
  const earlier = new Set(found.keys());
  for (const { record, pattern } of page) {
    const entry = earlier.has(pattern) ? found.get(pattern) : undefined;
    if (!entry) continue;
    entry.records.push(record);
    entry.count += 1;
  }
  for (const entry of memory.fresh(page)) if (!earlier.has(entry.pattern)) found.set(entry.pattern, entry);
  for (const entry of found.values())
    if (entry.records.length > keep) entry.records.splice(0, entry.records.length - keep);
  memory.remember(page);
}
