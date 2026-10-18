/**
 * The scoreboard against a real store, as its own role, on an invented answer key.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, listen, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { KeyEntry } from '../../../../policy/scoreboard.ts';
import { wakeLoop } from '../../src/scoreboard/loop.ts';
import { Scoreboard } from '../../src/scoreboard/worker.ts';

const KEY: KeyEntry[] = [
  { id: 'a', fingerprint: { route: '/a', class: 'server-error' } },
  { id: 'b', fingerprint: { route: '/b', class: 'slow-response' } },
];

let database: Database;
let factory: EventWriter;
let now = Date.parse('2026-10-11T07:00:00Z');
beforeEach(async () => {
  database = await freshDatabase('scoreboard');
  factory = new EventWriter(database.writer, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  now = Date.parse('2026-10-11T07:00:00Z');
});
afterEach(() => database?.end());

const scoreboard = (key: KeyEntry[] | null = KEY, sql = database.scoreboard) =>
  new Scoreboard({
    sql,
    events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
    key,
    now: () => new Date(now),
  });

const event = <K extends NewEvent['type']>(workItem: string, type: K, payload: PayloadOf<K>) =>
  ({
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor: 'triage',
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

/** A probe's ticket on `route`, opened now. */
async function ticket(route: string, symptom: 'server-error' | 'slow-response' = 'server-error'): Promise<string> {
  const workItem = await nextWorkItem(database.writer);
  await factory.append([
    event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'A defect', sample: false }),
    event(workItem, 'signal.received', { sense: 'probe', check: 'a check', route, version: 'v0.9.3', symptom }),
    event(workItem, 'ticket.opened', {
      title: `A defect on ${route}`,
      category: 'errors',
      severity: 'broken',
      fingerprint: { route, class: symptom },
      traces: [],
    }),
  ]);
  return workItem;
}

async function verify(workItem: string, dryRun = false) {
  await factory.append([
    event(workItem, 'verification.finished', {
      outcome: 'cleared',
      sense: 'probe',
      check: 'a check',
      version: 'v0.9.4',
      against: 'v0.9.3',
      pages: [],
      dryRun,
    }),
    event(workItem, 'work-item.closed', { outcome: 'verified', reason: 'Cleared' }),
  ]);
}

const published = async () =>
  (
    await database.owner<{ actor: string; payload: unknown }[]>`
      select actor, payload from events where type = 'score.updated' order by seq`
  ).map((row) => row.payload);

describe('the scoreboard', () => {
  it('does nothing until the store holds real events', async () => {
    expect(await scoreboard().pass()).toEqual({ pass: 'not-real' });
    expect(await published()).toEqual([]);
  });

  it('says once that it is off when it has no key', async () => {
    await ticket('/a');
    expect((await scoreboard(null).pass()).pass).toBe('published');
    expect((await scoreboard(null).pass()).pass).toBe('unchanged');
    expect(await published()).toEqual([{ keyed: false }]);
  });

  it('publishes found on its cadence, verified at once, and nothing when nothing changed', async () => {
    const a = await ticket('/a');
    await ticket('/z'); // finds nothing, and is never published as such
    expect((await scoreboard().pass()).pass).toBe('published');
    expect(await published()).toEqual([{ keyed: true, entries: 2, found: 0, verified: 0, medianMs: null }]);

    now += 30 * 60_000;
    await verify(a);
    expect((await scoreboard().pass()).pass).toBe('published');
    now = Date.parse('2026-10-11T12:00:00Z'); // the next boundary
    expect((await scoreboard().pass()).pass).toBe('unchanged');

    const b = await ticket('/b', 'slow-response');
    now += 10 * 60_000;
    expect((await scoreboard().pass()).pass).toBe('unchanged'); // opened after the last boundary
    now += 60 * 60_000;
    await verify(b, true); // a dry run’s word fixes nothing
    now = Date.parse('2026-10-11T18:00:00Z');
    expect((await scoreboard().pass()).pass).toBe('published');

    expect(await published()).toEqual([
      { keyed: true, entries: 2, found: 0, verified: 0, medianMs: null },
      { keyed: true, entries: 2, found: 1, verified: 1, medianMs: 30 * 60_000 },
      { keyed: true, entries: 2, found: 2, verified: 1, medianMs: 30 * 60_000 },
    ]);
  });

  it('counts a hold Martin approved with no verification, and drops a ticket that reopens', async () => {
    const a = await ticket('/a');
    now += 20 * 60_000;
    await factory.append(event(a, 'work-item.closed', { outcome: 'verified', reason: 'Martin approved it' }));
    await scoreboard().pass();
    now += 20 * 60_000;
    await factory.append(
      event(a, 'work-item.reopened', {
        sense: 'probe',
        check: 'a check',
        route: '/a',
        version: 'v0.9.4',
        reason: 'It came back',
        dryRun: false,
      }),
    );
    await scoreboard().pass();
    expect(await published()).toEqual([
      { keyed: true, entries: 2, found: 1, verified: 1, medianMs: 20 * 60_000 },
      { keyed: true, entries: 2, found: 1, verified: 0, medianMs: null },
    ]);
  });

  it('appends as its own actor, on the line', async () => {
    await ticket('/a');
    await scoreboard().pass();
    const [row] = await database.owner<{ actor: string; work_item: string | null; summary: string }[]>`
      select actor, work_item, summary from events where type = 'score.updated'`;
    expect(row).toEqual({
      actor: 'scoreboard',
      work_item: null,
      summary: 'The scoreboard: 0 of 2 found, 0 verified fixed',
    });
  });

  it("moves found at the cadence's boundary on the minute's timer, with nothing appended", async () => {
    // Only the timer is faked: the store's driver keeps its own.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const stop = Promise.withResolvers<void>();
    let done: Promise<void> | undefined;
    try {
      now = Date.parse('2026-10-11T11:58:00Z');
      await ticket('/a');
      const board = scoreboard();
      const sql = database.scoreboard;
      const passes: string[] = [];
      done = wakeLoop(
        {
          listen: (wake) => listen(sql, wake, wake),
          pass: async () => void passes.push((await board.pass()).pass),
          failed: (error) => passes.push(String(error)),
          everyMs: 60_000,
        },
        () => stop.promise,
      );
      // Woken as it starts listening, then by its own append, which changes nothing.
      await vi.waitFor(() => expect(passes).toEqual(['published', 'unchanged']));
      expect(await published()).toEqual([{ keyed: true, entries: 2, found: 0, verified: 0, medianMs: null }]);

      now = Date.parse('2026-10-11T12:00:30Z'); // past the boundary, with nothing appended
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(() => expect(passes).toEqual(['published', 'unchanged', 'published', 'unchanged']));
      expect((await published()).at(-1)).toEqual({ keyed: true, entries: 2, found: 1, verified: 0, medianMs: null });
    } finally {
      stop.resolve();
      await done;
      vi.useRealTimers();
    }
  });
});
