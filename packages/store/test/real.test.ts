import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiskArtifacts } from '../src/artifacts.ts';
import { EventWriter, nextWorkItem, storeKind } from '../src/events.ts';
import { realStore } from '../src/real-store.ts';
import { type Database, freshDatabase } from './database.ts';

let owner: Sql;
let writer: Sql;
let reader: Sql;
let database: Database;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const uuid = () => crypto.randomUUID();

function opened(item: string, sample = false): NewEvent<'work-item.opened'> {
  return {
    id: uuid(),
    ts: '2026-10-04T09:00:00.000Z',
    work_item: item,
    type: 'work-item.opened',
    version: 1,
    actor: 'triage',
    summary: 'The crawler opened a work item',
    payload: { kind: 'defect-fix', title: 'A link on the about page leads nowhere', sample },
    artifacts: [],
  };
}

beforeAll(async () => {
  database = await freshDatabase('real');
  ({ owner, writer, reader } = database);
});

afterAll(() => database?.end());

describe('a real store', () => {
  it('is chosen by its first event, and recorded once', async () => {
    expect(await storeKind(writer)).toBeNull();
    await new EventWriter(writer, { kind: 'sample', artifacts }).append(opened('1262', true));
    expect(await storeKind(reader)).toBe('sample');
    await expect(owner`update store set sample = false`).rejects.toThrow('append-only');
  });

  it('replaces a store of samples with an empty one that refuses them', async () => {
    expect(await realStore(owner)).toEqual({ dropped: 1 });
    expect(await storeKind(writer)).toBe('real');
    await expect(new EventWriter(writer, { kind: 'sample', artifacts }).append(opened('1262', true))).rejects.toThrow(
      'this store holds real events, so it refuses samples',
    );
  });

  it('refuses to replace a store that holds real events, unless forced', async () => {
    await new EventWriter(writer, { kind: 'real', artifacts }).append(opened(await nextWorkItem(writer)));
    await expect(realStore(owner)).rejects.toThrow('This store holds 1 real events');
    expect(await realStore(owner, { force: true })).toEqual({ dropped: 1 });
  });

  it('numbers work items from 1000', async () => {
    expect([await nextWorkItem(writer), await nextWorkItem(writer)]).toEqual(['1000', '1001']);
  });
});

describe('appending again', () => {
  const real = () => new EventWriter(writer, { kind: 'real', artifacts });

  it('stores an event appended twice with the same id and content once', async () => {
    const event = opened(await nextWorkItem(writer));
    const [first] = await real().append(event);
    const [again] = await real().append({ ...event, payload: { ...event.payload } });
    expect(again?.seq).toBe(first?.seq);
    expect(await owner`select count(*)::int as n from events where id = ${event.id}`).toEqual([{ n: 1 }]);
  });

  it('stores the rest of a batch when part of it was stored before', async () => {
    const event = opened(await nextWorkItem(writer));
    await real().append(event);
    const closed: NewEvent<'work-item.closed'> = {
      ...event,
      id: uuid(),
      type: 'work-item.closed',
      summary: 'Closed with no ticket',
      payload: { outcome: 'discarded', reason: 'Not a defect' },
    };
    const stored = await real().append([event, closed]);
    expect(stored.map((e) => e.seq)).toEqual([stored[0]?.seq, (stored[0]?.seq ?? 0) + 1]);
  });

  it('refuses the same id with different content, saying what differs', async () => {
    const event = opened(await nextWorkItem(writer));
    await real().append(event);
    await expect(real().append({ ...event, summary: 'Something else' })).rejects.toThrow(
      `event ${event.id} is already stored, with a different summary`,
    );
  });
});

describe('the inbox', () => {
  const signal = {
    check: 'links lead somewhere',
    route: '/about',
    version: 'v0.9.6',
    symptom: 'broken-link',
  };

  it('takes signals from the factory and tells listeners', async () => {
    const heard: string[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await writer.listen('inbox', (id) => heard.push(id), ready.resolve);
    await ready.promise;
    const id = uuid();
    await writer`insert into inbox (id, sense, fingerprint, signal)
                 values (${id}, 'crawler', '/about broken-link', ${writer.json(signal)})`;
    await expect.poll(() => heard).toEqual([id]);
    await subscription.unlisten();
  });

  it('keeps a report without a fingerprint, and a sense’s signal only with one', async () => {
    await writer`insert into inbox (id, sense, signal) values (${uuid()}, 'report', '{}')`;
    await expect(writer`insert into inbox (id, sense, signal) values (${uuid()}, 'crawler', '{}')`).rejects.toThrow(
      'check constraint',
    );
  });

  it('lets triage record what it made of a signal, and nothing else', async () => {
    const id = uuid();
    await writer`insert into inbox (id, sense, fingerprint, signal)
                 values (${id}, 'crawler', '/about broken-link', ${writer.json(signal)})`;
    await writer`update inbox set triaged_at = now(), outcome = 'opened', work_item = '1000' where id = ${id}`;
    await expect(writer`update inbox set signal = '{}' where id = ${id}`).rejects.toThrow('permission denied');
    await expect(writer`delete from inbox where id = ${id}`).rejects.toThrow('permission denied');
  });

  it('is closed to the console, because reports are in it', async () => {
    await expect(reader`select signal from inbox`).rejects.toThrow('permission denied');
  });
});
