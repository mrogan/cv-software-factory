/**
 * What the line has recorded of the app's releases, read back from their events, and how it names them: on their own,
 * with nothing but the events package to import, so the admin service reads a release as the line does without the
 * watch's reads and their settings. The line and the admin service read the records from the store with the same
 * queries (`releaseRecords`, `lastPromoted`).
 */
import { type PayloadOf, type RawEvent, RELEASE_TYPES, upcast } from '@software-factory/events';
import type { Sql } from 'postgres';

type Started = PayloadOf<'release.started'>;

/** A work item, or null for the line itself. */
export type Target = string | null;

/** What one work item (or the line) has recorded of one release. */
export interface TargetRecord {
  /** Its latest start, and when the line recorded it. */
  started: Started;
  startedAt: string;
  /** How many times it started: more than once when it was retried after a rollback. */
  attempts: number;
  /** Steps recorded, over every attempt. */
  steps: number;
  /** Steps recorded before its latest start: the rest are its latest attempt's. */
  stepsBefore: number;
  /** How its latest attempt ended, if it has. */
  ended: 'promoted' | 'rolled-back' | 'errored' | 'aborted' | undefined;
  /** When Argo Rollouts acted on its latest abort, if it was aborted or its analysis erred. */
  abortedAt?: string;
  /**
   * The time up to which its background analysis's looks are accounted for: the latest look it recorded
   * (`canary.measuring`), or the latest end of an attempt, when later, as the looks before an end are an attempt's
   * that is over. A release retried keeps it.
   */
  lookedUntil?: string;
}

/** The events that end a release's attempt. */
const ENDS = new Set(['release.promoted', 'release.rolled-back', 'release.aborted', 'release.errored']);

/** Moves the time a record's looks are accounted for up to `at`, if it is later. */
const looked = (record: TargetRecord, at: string) => {
  if (!record.lookedUntil || Date.parse(at) > Date.parse(record.lookedUntil)) record.lookedUntil = at;
};

/** What is recorded of each release, by its name, and on each target. */
export type Recorded = Map<string, Map<Target, TargetRecord>>;

/** The release events recorded, in order, as the store has them, upcast. */
export function recordedFrom(
  events: readonly { work_item: string | null; ts: string; type: string; payload: unknown }[],
): Recorded {
  const recorded: Recorded = new Map();
  for (const { work_item: target, ts, type, payload } of events) {
    const name = (payload as { release?: string }).release;
    if (!name) continue;
    const targets = recorded.get(name) ?? new Map<Target, TargetRecord>();
    recorded.set(name, targets);
    const record = targets.get(target);
    if (type === 'release.started') {
      targets.set(target, {
        started: payload as Started,
        startedAt: ts,
        attempts: (record?.attempts ?? 0) + 1,
        steps: record?.steps ?? 0,
        stepsBefore: record?.steps ?? 0,
        ended: undefined,
        ...(record?.lookedUntil ? { lookedUntil: record.lookedUntil } : {}),
      });
      continue;
    }
    if (!record) continue;
    if (type === 'canary.stepped') record.steps += 1;
    if (type === 'canary.measuring') looked(record, (payload as PayloadOf<'canary.measuring'>).at);
    if (ENDS.has(type)) looked(record, ts);
    if (type === 'release.promoted') record.ended = 'promoted';
    if (type === 'release.rolled-back') record.ended = 'rolled-back';
    if (type === 'release.aborted' || type === 'release.errored') {
      record.ended = type === 'release.aborted' ? 'aborted' : 'errored';
      record.abortedAt = (payload as PayloadOf<'release.aborted' | 'release.errored'>).abortedAt;
    }
  }
  return recorded;
}

/** The annotation Argo Rollouts keeps its revision in, on the Rollout and on each run it makes. */
export const REVISION = 'rollout.argoproj.io/revision';

/** A release's name: the canary's pod-template hash and the Rollout's revision when it started. */
export const releaseName = (hash: string, revision: string) => `${hash}-${revision}`;

/** A version as a reader takes it in: a commit by its first seven characters, anything else as it is. */
export const short = (version: string) => (/^[0-9a-f]{8,40}$/.test(version) ? version.slice(0, 7) : version);

/** A release event as `recordedFrom` reads it. */
export interface RecordedRow {
  work_item: string | null;
  ts: string;
  type: string;
  payload: unknown;
}

/**
 * The release events recorded for these releases, upcast, in order; or, `byHash`, for every release of these versions,
 * whatever its revision: the line's record of a release in flight may be under another name than the Rollout's
 * (`namedReleases`), and only the record of every release of its hash says which.
 */
export async function releaseRecords(sql: Sql, names: readonly string[], byHash = false): Promise<RecordedRow[]> {
  if (!names.length) return [];
  const release = byHash ? sql`split_part(payload->>'release', '-', 1)` : sql`payload->>'release'`;
  const rows = await sql<(RawEvent & { work_item: string | null; ts: Date })[]>`
    select seq, work_item, ts, type, version, payload from events
    where type in ${sql(RELEASE_TYPES as string[])} and ${release} in ${sql(names as string[])}
    order by seq`;
  return rows.flatMap((row) => {
    const read = upcast({ ...row, seq: Number(row.seq) });
    if (!read.ok) return [];
    const { type, payload } = read.event;
    return [{ work_item: row.work_item, ts: new Date(row.ts).toISOString(), type, payload }];
  });
}

/**
 * The app's last release that shipped, by its name, and the version it made stable. A promotion of version 1, from
 * before releases were named, has no name, and says nothing of which image shipped last.
 */
export async function lastPromoted(sql: Sql): Promise<{ release: string | undefined; version: string } | undefined> {
  const [row] = await sql<{ release: string | null; version: string }[]>`
    select payload->>'release' as release, payload->>'version' as version from events
    where type = 'release.promoted' and (payload->>'dryRun')::boolean is not true
    order by seq desc limit 1`;
  return row && { release: row.release ?? undefined, version: row.version };
}
