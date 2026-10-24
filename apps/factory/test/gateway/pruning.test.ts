/**
 * Pruning a recording gateway's cassettes, against the store as the gateway's own role: what goes two weeks after the
 * work items its calls name have closed, after its last call, or after it was written, what goes once a visitor's
 * report may be kept no longer, and what stays.
 */
import { mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { pruneCassettes, startPruning } from '../../src/gateway/pruning.ts';

const NOW = new Date('2026-10-19T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

let database: Database;
let dir: string;
let n = 0;
beforeEach(async () => {
  database = await freshDatabase('cassettes');
  dir = mkdtempSync(join(tmpdir(), 'cassettes-'));
});
afterEach(() => database?.end());

/** A cassette file, written `days` ago, and its key. */
function cassette(days: number, name?: string): string {
  const key = (n++).toString(16).padStart(64, '0');
  const file = join(dir, name ?? `${key}.json`);
  writeFileSync(file, '{}\n');
  utimesSync(file, daysAgo(days), daysAgo(days));
  return key;
}

/** A call recorded `days` ago, for a work item or none, that names a cassette. */
async function call(key: string, days: number, workItem: string | null, questionSet = 'messages') {
  await database.as.gateway`
    insert into model_calls (id, at, agent, work_item, provider, model, question_set, duration_ms, cassette, outcome)
    values (${crypto.randomUUID()}, ${daysAgo(days)}, 'coder', ${workItem}, 'anthropic', 'claude-sonnet-4-5',
            ${questionSet}, 1, ${key}, 'answered')`;
}

/** A work item closed, or reopened, `days` ago. */
async function ended(workItem: string, type: 'work-item.closed' | 'work-item.reopened', days: number) {
  await database.owner`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample,
                        appended_at)
    values (${crypto.randomUUID()}, ${daysAgo(days)}, ${workItem}, ${type}, 1, 'line', 'ended', '{}', '[]', '{}',
            false, ${daysAgo(days)})`;
}

const left = () => readdirSync(dir).sort();
const file = (key: string) => `${key}.json`;

describe('pruning the cassettes', () => {
  it('deletes a work item’s cassettes two weeks after it closed, and not before', async () => {
    const closedLongAgo = cassette(30);
    await call(closedLongAgo, 30, '1000');
    await ended('1000', 'work-item.closed', 20);
    const closedLately = cassette(30);
    await call(closedLately, 30, '1001');
    await ended('1001', 'work-item.closed', 5);
    const open = cassette(30);
    await call(open, 30, '1002');
    const reopened = cassette(30);
    await call(reopened, 30, '1003');
    await ended('1003', 'work-item.closed', 25);
    await ended('1003', 'work-item.reopened', 20);

    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: NOW })).toEqual({ deleted: 1, failed: 0 });
    expect(left()).toEqual([closedLately, open, reopened].map(file).sort());
  });

  it('keeps a cassette several work items name until the last of them has been closed two weeks', async () => {
    const shared = cassette(30);
    await call(shared, 30, '1000');
    await call(shared, 29, '1001');
    await ended('1000', 'work-item.closed', 20);
    await ended('1001', 'work-item.closed', 10);
    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: NOW })).toEqual({ deleted: 0, failed: 0 });
    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: daysAgo(-5) })).toEqual({
      deleted: 1,
      failed: 0,
    });
  });

  it('deletes a cassette whose calls name no work item two weeks after its last call', async () => {
    const quiet = cassette(30);
    await call(quiet, 20, null);
    const askedLately = cassette(30);
    await call(askedLately, 20, null);
    await call(askedLately, 3, null);
    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: NOW })).toEqual({ deleted: 1, failed: 0 });
    expect(left()).toEqual([file(askedLately)]);
  });

  it('deletes a file no call names two weeks after it was written, half-written ones too', async () => {
    cassette(20);
    const fresh = cassette(3);
    cassette(20, `${'f'.repeat(64)}.json.42.tmp`);
    writeFileSync(join(dir, 'README'), 'not a cassette');
    utimesSync(join(dir, 'README'), daysAgo(20), daysAgo(20));
    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: NOW })).toEqual({ deleted: 2, failed: 0 });
    expect(left()).toEqual(['README', file(fresh)].sort());
  });

  it('keeps a file written lately whatever its calls say, and never changes the ledger', async () => {
    const rewritten = cassette(1);
    await call(rewritten, 30, '1000');
    await ended('1000', 'work-item.closed', 20);
    const gone = cassette(30);
    await call(gone, 30, '1000');
    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: NOW })).toEqual({ deleted: 1, failed: 0 });
    expect(left()).toEqual([file(rewritten)]);
    const counted = await database.as.gateway<{ calls: number }[]>`select count(*)::int as calls from model_calls`;
    expect(counted).toEqual([{ calls: 2 }]);
  });

  it('prunes nothing in a folder not made yet', async () => {
    expect(await pruneCassettes({ sql: database.as.gateway, dir: join(dir, 'none'), now: NOW })).toEqual({
      deleted: 0,
      failed: 0,
    });
  });

  it('prunes only agents’ cassettes where Jev’s calls are replayed from the folder, until a report’s time', async () => {
    const agents = cassette(30);
    await call(agents, 20, null);
    const judged = cassette(30);
    await call(judged, 20, null, 'triage/v2');
    const unnamed = cassette(20);
    // A report's time is up: what Jev was asked, and a file that could be one of its, go however they are replayed.
    const judgedLongAgo = cassette(40);
    await call(judgedLongAgo, 30, null, 'triage/v2');
    cassette(30); // and a file no call names, as old
    expect(await pruneCassettes({ sql: database.as.gateway, dir, now: NOW, agentsOnly: true })).toEqual({
      deleted: 3,
      failed: 0,
    });
    expect(left()).toEqual([judged, unnamed].map(file).sort());
  });

  it('never keeps a cassette that may hold a report past a report’s time, whatever else would keep it', async () => {
    // Kept longer than a report may be, the usual rule would keep both; and a work item still open keeps an agent's.
    const judged = cassette(40);
    await call(judged, 30, '1000', 'passage/v1');
    const agents = cassette(40);
    await call(agents, 30, '1000');
    const judgedLately = cassette(40);
    await call(judgedLately, 28, null, 'triage/v2');
    cassette(30); // a file no call names
    const pruned = await pruneCassettes({ sql: database.as.gateway, dir, now: NOW, keepDays: 60 });
    expect(pruned).toEqual({ deleted: 2, failed: 0 });
    expect(left()).toEqual([agents, judgedLately].map(file).sort());
  });

  it('prunes as it starts, logs what went, and waits for a prune in flight when stopped', async () => {
    cassette(30);
    const told: string[] = [];
    const log = { info: (_: object, message: string) => told.push(message), warn: () => {} };
    const pruner = startPruning({ sql: database.as.gateway, dir }, log, 60_000);
    await pruner.stop();
    expect(left()).toEqual([]);
    expect(told).toEqual(['deleted the cassettes no longer kept']);
  });
});
