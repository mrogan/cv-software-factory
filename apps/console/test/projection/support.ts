/**
 * Events for the projection's tests: the samples' event log, and a small builder for hand-made cases.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type Actor,
  type EventType,
  type PayloadOf,
  type PublicEvent,
  parseLog,
  upcast,
} from '@software-factory/events';

export const SAMPLES: PublicEvent[] = parseLog(
  readFileSync(fileURLToPath(new URL('../../../../packages/samples/log/events.ndjson', import.meta.url)), 'utf-8'),
).map((raw) => {
  const result = upcast(raw);
  if (!result.ok) throw new Error(`The samples hold an event the console does not understand: ${raw.type}`);
  return result.event;
});

export const END = Date.parse(SAMPLES.at(-1)?.ts ?? '');

let seq = 0;

/** Events for one work item, minutes from a start. */
interface Builder {
  events: PublicEvent[];
  at(minute: number): number;
  add<K extends EventType>(minute: number, type: K, actor: Actor, payload: PayloadOf<K>, summary?: string): Builder;
  open(kind?: PayloadOf<'work-item.opened'>['kind']): Builder;
}

export function work(number: string, start = Date.parse('2026-10-03T09:00:00Z')): Builder {
  const events: PublicEvent[] = [];
  const builder: Builder = {
    events,
    at: (minute: number) => start + minute * 60_000,
    add(minute, type, actor, payload, summary = type) {
      events.push({
        id: `${number}-${events.length}`,
        seq: ++seq,
        ts: new Date(start + minute * 60_000).toISOString(),
        work_item: number,
        type,
        version: 1,
        actor,
        summary,
        payload,
        artifacts: [],
      } as PublicEvent);
      return builder;
    },
    open(kind = 'defect-fix') {
      return builder.add(0, 'work-item.opened', 'factory', { kind, title: `Item ${number}`, sample: true });
    },
  };
  return builder;
}

const COMMIT = 'a'.repeat(40);

export const payloads = {
  signal: {
    sense: 'probe',
    check: 'products journey',
    route: '/products',
    version: 'v0.9.4',
  } satisfies PayloadOf<'signal.received'>,
  gatesStarted: { pullRequest: 7, commit: COMMIT, checks: ['Unit tests'] } satisfies PayloadOf<'gates.started'>,
  gatesFailed: {
    pullRequest: 7,
    commit: COMMIT,
    conclusion: 'failed',
    passed: 0,
    failed: ['Unit tests'],
  } satisfies PayloadOf<'gates.finished'>,
  gatesPassed: {
    pullRequest: 7,
    commit: COMMIT,
    conclusion: 'passed',
    passed: 1,
    failed: [],
  } satisfies PayloadOf<'gates.finished'>,
};
