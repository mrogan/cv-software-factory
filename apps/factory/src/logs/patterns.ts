/**
 * New error patterns. Two errors that differ only in a number, an identifier or a quoted value are one error, so
 * each message is reduced to a pattern, and a pattern the log has not shown in the previous day is news.
 */
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

/** A pattern new to the log, with the records that show it in the batch. */
export interface NewPattern {
  pattern: string;
  records: LogRecord[];
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
      if (isNew && !found.has(pattern)) found.set(pattern, { pattern, records: [] });
      found.get(pattern)?.records.push(record);
    }
    return [...found.values()];
  }

  /** Notes that the batch has been dealt with, so its patterns are no longer new. */
  remember(batch: ErrorRecord[]): void {
    for (const { record, pattern } of batch) {
      this.lastSeen.set(pattern, Math.max(this.lastSeen.get(pattern) ?? 0, record.time.getTime()));
    }
  }
}
