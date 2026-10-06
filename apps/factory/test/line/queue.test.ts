import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { type Pending, Queue } from '../../src/line/queue.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('queue');
});
afterEach(() => database?.end());

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
