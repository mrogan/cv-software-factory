/**
 * The caps in force, read from the store as the latest event under each cap: the factory's day and month, and each
 * provider's own; and, given a seq, every cap set after it too.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { capOn, capsInForce, lastSeq } from '../../src/line/caps.ts';

let database: Database;
let events: EventWriter;
beforeEach(async () => {
  database = await freshDatabase('line_caps');
  events = new EventWriter(database.as.line, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
});
afterEach(() => database?.end());

const event = <K extends 'spend.capped' | 'spend.cleared'>(type: K, payload: PayloadOf<K>): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: null,
    type,
    version: VERSIONS[type],
    actor: 'factory',
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

const day = { cap: 'day' as const, limitUsd: 20, spentUsd: 20, resets: '2026-10-31T00:00:00.000Z' };
const month = { cap: 'month' as const, limitUsd: 100, spentUsd: 100, resets: '2026-11-01T00:00:00.000Z' };
const credit = {
  cap: 'provider' as const,
  provider: 'anthropic' as const,
  reason: 'credit' as const,
  message: 'No credit.',
};
const keys = (caps: { cap: string }[]) => caps.map((c) => c.cap);

describe('the caps in force', () => {
  it('are each cap’s latest event, set and not cleared since, however long the history', async () => {
    expect(await capsInForce(database.as.line)).toEqual([]);
    for (let i = 0; i < 5; i++) {
      await events.append([event('spend.capped', day)]);
      await events.append([event('spend.cleared', { cap: 'day' })]);
    }
    await events.append([event('spend.capped', month)]);
    await events.append([event('spend.capped', credit)]);
    await events.append([event('spend.capped', day)]);
    expect(keys(await capsInForce(database.as.line))).toEqual(['month', 'anthropic', 'day']);
    await events.append([event('spend.cleared', { cap: 'provider', provider: 'anthropic' })]);
    await events.append([event('spend.cleared', { cap: 'month' })]);
    const caps = await capsInForce(database.as.line);
    expect(keys(caps)).toEqual(['day']);
    expect(caps[0]?.reason).toBe('the day’s cap');
    // The factory's own refuse every provider's calls; a provider's own only its.
    expect(capOn(caps, 'local')?.cap).toBe('day');
  });

  it('given a seq, add every cap set after it, cleared or not, once', async () => {
    await events.append([event('spend.capped', month)]);
    const from = await lastSeq(database.as.line);
    await events.append([event('spend.capped', credit)]);
    await events.append([event('spend.cleared', { cap: 'provider', provider: 'anthropic' })]);
    await events.append([event('spend.capped', day)]);
    const caps = await capsInForce(database.as.line, from);
    expect(keys(caps)).toEqual(['month', 'day', 'anthropic']);
    expect(caps.find((c) => c.cap === 'anthropic')?.reason).toBe('anthropic refuses (credit)');
  });
});
