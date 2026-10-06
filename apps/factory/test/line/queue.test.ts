import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { type Pending, Queue } from '../../src/line/queue.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('queue');
});
afterEach(() => database?.end());

/** A ticket as triage opens one, with its severity. */
async function ticket(severity: 'broken' | 'degraded' | 'cosmetic', route: string): Promise<string> {
  const events = new EventWriter(database.writer, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  const workItem = await nextWorkItem(database.writer);
  const event = (type: 'work-item.opened' | 'ticket.opened', payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type],
      actor: 'triage',
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;
  await events.append([
    event('work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false }),
    event('ticket.opened', {
      title: `Server errors on ${route}`,
      category: 'errors',
      severity,
      fingerprint: { route, class: 'server-error' },
      traces: [],
    }),
  ]);
  return workItem;
}

const end = (workItem: string) => database.writer`update line set stage = 'ended' where work_item = ${workItem}`;

const pending: Pending = {
  agent: 'reviewer',
  round: 1,
  job: 'reviewer-1001-1',
  since: 7,
  commit: 'a'.repeat(40),
  base: 'b'.repeat(40),
  handback: { ending: 'finished', patch: '', note: 'Reviewed.', turns: 4, session: null },
  called: [],
  begun: [],
  done: {},
  tries: 0,
  failure: null,
  retryAt: null,
};

describe('a kept handback', () => {
  it('keeps what each write gave back, nothing among it, and stays kept', async () => {
    const queue = new Queue(database.writer, 'test');
    await database.writer`insert into line (work_item, stage) values ('1001', 'review')`;
    await queue.keep('1001', pending);
    await queue.begun('1001', 'check-run');
    await queue.done('1001', 'check-run', 42);
    await queue.begun('1001', 'review');
    // A write that gives back nothing, as a review does.
    await queue.done('1001', 'review', null);
    const kept = (await queue.get('1001'))?.effects;
    expect(kept).toMatchObject({ begun: ['check-run', 'review'], done: { 'check-run': 42, review: null } });
  });
});

describe('a queue of one work item', () => {
  it('sees only that work item on the line, and the whole line sees them all', async () => {
    await database.writer`insert into line (work_item, stage) values ('1001', 'build'), ('1002', 'plan'), ('1003', 'review')`;
    const one = new Queue(database.writer, 'test', { only: '1002' });
    expect((await one.free()).map((i) => i.workItem)).toEqual(['1002']);
    expect(await one.claim('1002', 60)).toMatchObject({ workItem: '1002' });
    expect(await one.free()).toEqual([]);
    const all = new Queue(database.writer, 'other');
    expect((await all.free()).map((i) => i.workItem).sort()).toEqual(['1001', '1003']);
  });
});

describe('a queue with a limit', () => {
  it('takes tickets by its rule until it has taken that many in all, and none after, though it restarts', async () => {
    const cosmetic = await ticket('cosmetic', '/');
    const broken = await ticket('broken', '/search');
    const degraded = await ticket('degraded', '/products');
    const two = new Queue(database.writer, 'test', { take: 2 });
    expect(await two.admit()).toBe(broken);
    await end(broken);
    expect(await two.admit()).toBe(degraded);
    await end(degraded);
    // Two have come onto the line: the cosmetic ticket waits, for this queue and for one that starts afresh.
    expect(await two.admit()).toBeUndefined();
    expect(await new Queue(database.writer, 'again', { take: 2 }).admit()).toBeUndefined();
    expect(await new Queue(database.writer, 'all').admit()).toBe(cosmetic);
  });

  it('counts the work items already on the line, and takes none at all with a limit of none', async () => {
    await ticket('broken', '/search');
    expect(await new Queue(database.writer, 'test', { take: 0 }).admit()).toBeUndefined();
    await database.writer`insert into line (work_item, stage) values ('1001', 'ended')`;
    expect(await new Queue(database.writer, 'test', { take: 1 }).admit()).toBeUndefined();
    expect(await new Queue(database.writer, 'test', { take: 2 }).admit()).toBeDefined();
  });
});
