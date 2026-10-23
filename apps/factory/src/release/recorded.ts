/**
 * What the line has recorded of the app's releases, read back from their events, and how it names them: on their own,
 * with nothing but the events package to import, so the admin service reads a release as the line does without the
 * watch's reads and their settings.
 */
import type { PayloadOf } from '@software-factory/events';

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
}

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
      });
      continue;
    }
    if (!record) continue;
    if (type === 'canary.stepped') record.steps += 1;
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
