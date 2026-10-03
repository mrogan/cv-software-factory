/**
 * Reading and writing event-log folders on disk (log-format.ts describes the format). Node only.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, EVENTS_FILE, formatLog, parseLog } from './log-format.ts';
import type { PublicEvent } from './types.ts';
import type { RawEvent } from './upcast.ts';

export * from './log-format.ts';

export const readLogEvents = (dir: string): RawEvent[] => parseLog(readFileSync(join(dir, EVENTS_FILE), 'utf-8'));

export const logArtifactPath = (dir: string, hash: string): string => join(dir, ARTIFACTS_DIR, hash);

/** Writes a log's events. Its artifacts are written separately, by hash, into `<dir>/artifacts`. */
export function writeLogEvents(dir: string, events: readonly PublicEvent[]): void {
  mkdirSync(join(dir, ARTIFACTS_DIR), { recursive: true });
  writeFileSync(join(dir, EVENTS_FILE), formatLog(events));
}
