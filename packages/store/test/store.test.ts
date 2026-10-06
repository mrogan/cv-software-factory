import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiskArtifacts } from '../src/artifacts.ts';
import { AppendRefused, EventWriter, listen, readPublic } from '../src/events.ts';
import { migrate } from '../src/migrate.ts';
import { type Database, freshDatabase } from './database.ts';

let owner: Sql; // the database's owner, as the migration Job connects
let writer: Sql;
let reader: Sql;
let database: Database;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));

beforeAll(async () => {
  database = await freshDatabase('store');
  ({ owner, writer, reader } = database);
});

afterAll(() => database?.end());

let n = 0;
/** A fresh work item number for each test, so tests don't trip over each other's items. */
const nextItem = () => String(2000 + ++n);
const uuid = () => crypto.randomUUID();
const at = (minute: number) => new Date(Date.UTC(2026, 9, 2, 12, minute)).toISOString();

function opened(item: string, sample = true): NewEvent<'work-item.opened'> {
  return {
    id: uuid(),
    ts: at(0),
    work_item: item,
    type: 'work-item.opened',
    version: 1,
    actor: 'visitor',
    summary: 'A visitor sent a report',
    payload: { kind: 'visitor-report', title: 'A report on the clock', sample, visitor: { key: 'amber-otter' } },
    artifacts: [],
  };
}

function report(item: string): NewEvent<'signal.received'> {
  return {
    id: uuid(),
    ts: at(1),
    work_item: item,
    type: 'signal.received',
    version: 1,
    actor: 'widget',
    summary: 'Report: the clock says ten past four',
    payload: {
      sense: 'report',
      check: 'report widget',
      route: '/products/:slug',
      version: 'v0.9.2',
      report: { page: '/products/clock-stopped', text: 'the clock says ten past four' },
    },
    artifacts: [],
  };
}

const samples = () => new EventWriter(writer, { kind: 'sample', artifacts });

describe('migrations', () => {
  it('apply once: a second run finds nothing to do', async () => {
    expect(await migrate(owner)).toEqual([]);
    expect(await owner`select version, name from schema_migrations order by version`).toEqual([
      { version: 1, name: 'events' },
      { version: 2, name: 'store-kind-work-items-and-inbox' },
      { version: 3, name: 'model-calls' },
      { version: 4, name: 'job-tokens-and-agent-calls' },
      { version: 5, name: 'line' },
      { version: 6, name: 'line-effects' },
    ]);
  });
});

describe('appending', () => {
  it('stores a work item’s events in order, each with its public view', async () => {
    const item = nextItem();
    const stored = await samples().append([opened(item), report(item)]);
    expect(stored.map((e) => e.seq)).toEqual([stored[0]?.seq, (stored[0]?.seq ?? 0) + 1]);
    expect(stored[1]?.public.summary).toBe('A visitor reported a problem on /products/clock-stopped');

    const read = await readPublic(reader, (stored[0]?.seq ?? 1) - 1);
    expect(read.map(({ event }) => event.type)).toEqual(['work-item.opened', 'signal.received']);
    expect(JSON.stringify(read)).not.toContain('ten past four');
    expect(JSON.stringify(read)).not.toContain('amber-otter');
  });

  it('refuses an invalid event, with the reason, and stores nothing from its batch', async () => {
    const item = nextItem();
    const bad = { ...report(item), payload: { ...report(item).payload, route: 'products' } };
    const error = await samples()
      .append([opened(item), bad])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppendRefused);
    expect((error as AppendRefused).problems).toEqual([
      'event 2 (signal.received): payload.route: a path, such as /products/:slug',
    ]);
    expect(await owner`select 1 from events where work_item = ${item}`).toHaveLength(0);
  });

  it('opens a work item once, before anything else happens to it', async () => {
    const item = nextItem();
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} has not been opened`);
    await samples().append(opened(item));
    await expect(samples().append(opened(item))).rejects.toThrow(`work item ${item} is already open`);
  });

  it('accepts nothing after a work item closes but its summary', async () => {
    const item = nextItem();
    const close: NewEvent<'work-item.closed'> = {
      ...opened(item),
      id: uuid(),
      type: 'work-item.closed',
      actor: 'triage',
      summary: 'Closed: not a defect',
      payload: { outcome: 'no-change', reason: 'The page says the clock is stopped' },
    };
    const summary: NewEvent<'work-item.summarised'> = {
      ...opened(item),
      id: uuid(),
      type: 'work-item.summarised',
      actor: 'triage',
      summary: 'Summarised',
      payload: { title: 'A visitor says the clock is wrong', description: 'It is sold as stopped.', story: 'It is.' },
    };
    await samples().append([opened(item), close, summary]);
    await expect(samples().append(report(item))).rejects.toThrow(`work item ${item} is closed`);
  });

  it('refuses an artifact the artifact store does not have', async () => {
    const item = nextItem();
    const hash = await artifacts.put(new TextEncoder().encode('FAIL test/money.test.ts'));
    const file = { kind: 'file', hash, type: 'text/plain', name: 'output', size: 23 } as const;
    await samples().append({ ...opened(item), artifacts: [file] });
    const missing = { ...file, hash: 'f'.repeat(64) };
    await expect(samples().append({ ...opened(nextItem()), artifacts: [missing] })).rejects.toThrow(
      `artifact ${'f'.repeat(64)} is not in the artifact store`,
    );
  });

  it('notifies listeners when the append commits', async () => {
    const heard: number[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await listen(reader, (seq) => heard.push(seq), ready.resolve);
    await ready.promise;
    const item = nextItem();
    const [first] = await samples().append(opened(item));
    await expect.poll(() => heard).toContain(first?.seq);
    await subscription.unlisten();
  });

  it('commits events in seq order, however many writers append at once', async () => {
    const before = Number((await owner`select coalesce(max(seq), 0) as max from events`)[0]?.max);
    const heard: number[] = [];
    const ready = Promise.withResolvers<void>();
    const subscription = await listen(reader, (seq) => heard.push(seq), ready.resolve);
    await ready.promise;
    await Promise.all(Array.from({ length: 12 }, () => samples().append(opened(nextItem()))));
    await expect.poll(() => heard.filter((seq) => seq > before)).toHaveLength(12);
    const after = heard.filter((seq) => seq > before);
    expect(after).toEqual([...after].sort((a, b) => a - b));
    await subscription.unlisten();
  });
});

describe('append-only, by mechanism', () => {
  it('lets nobody update, delete or truncate an event, not even its owner', async () => {
    await samples().append(opened(nextItem()));
    await expect(owner`update events set summary = 'rewritten'`).rejects.toThrow('append-only, so update is refused');
    await expect(owner`delete from events`).rejects.toThrow('append-only, so delete is refused');
    await expect(owner`truncate events`).rejects.toThrow('append-only, so truncate is refused');
  });

  it('gives the factory’s writer no right to change an event', async () => {
    await expect(writer`update events set summary = 'rewritten'`).rejects.toThrow('permission denied');
    await expect(writer`delete from events`).rejects.toThrow('permission denied');
    await expect(writer`truncate events`).rejects.toThrow('permission denied');
  });

  it('lets the console read public views and nothing else', async () => {
    await expect(reader`select payload from events`).rejects.toThrow('permission denied');
    await expect(reader`select summary from events`).rejects.toThrow('permission denied');
    await expect(reader`select * from events`).rejects.toThrow('permission denied');
    expect(Array.isArray(await reader`select seq, public from events limit 1`)).toBe(true);
  });

  it('lets the console append nothing', async () => {
    const consoleWriter = new EventWriter(reader, { kind: 'sample', artifacts });
    await expect(consoleWriter.append(opened(nextItem()))).rejects.toThrow('permission denied');
    await expect(
      reader`insert into events (id, ts, type, version, actor, summary, payload, artifacts, public, sample)
             values (${uuid()}, now(), 'line.stopped', 1, 'martin', 'Stop', '{}', '[]', '{}', true)`,
    ).rejects.toThrow('permission denied');
  });

  it('never mixes samples with real events', async () => {
    const real = new EventWriter(writer, { kind: 'real', artifacts });
    await expect(real.append(opened(nextItem(), false))).rejects.toThrow(
      'this store holds sample events, so it refuses real ones',
    );
    await expect(samples().append(opened(nextItem(), false))).rejects.toThrow('this writer appends samples only');
  });
});

describe('reading', () => {
  it('upcasts an event stored at an older version', async () => {
    const item = nextItem();
    const [first] = await samples().append(opened(item));
    // As if a test-only version 1 of work-item.opened had called its title `name`; version 2 renamed it.
    const catalogue = {
      versions: { 'work-item.opened': 2 },
      upcasters: {
        'work-item.opened': { 1: ({ title, ...rest }: Record<string, unknown>) => ({ ...rest, name: title }) },
      },
    };
    const [read] = await readPublic(reader, (first?.seq ?? 1) - 1, { limit: 1, catalogue });
    expect(read?.understood).toBe(true);
    expect(read?.event).toMatchObject({ version: 2, payload: { name: 'A report on the clock' } });
  });

  it('passes on an event written by a newer factory, marked as not understood', async () => {
    const item = nextItem();
    const [first] = await samples().append(opened(item));
    const catalogue = { versions: {}, upcasters: {} };
    const [read] = await readPublic(reader, (first?.seq ?? 1) - 1, { limit: 1, catalogue });
    expect(read).toMatchObject({ understood: false, event: { type: 'work-item.opened', version: 1 } });
  });

  it('returns events after a seq, in order, up to a limit', async () => {
    const items = [nextItem(), nextItem(), nextItem()];
    const stored = await samples().append(items.map((item) => opened(item)));
    const from = stored[0]?.seq ?? 0;
    const read = await readPublic(reader, from, { limit: 1 });
    expect(read.map(({ event }) => event.seq)).toEqual([from + 1]);
  });
});
