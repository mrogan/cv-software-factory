/**
 * The pictures' index, in Postgres as the factory's writer: what the probes worker records, and what the line reads,
 * including the artifacts it may attach to an event without a way to the store.
 */
import { type NewEvent, type Screenshot, VERSIONS } from '@software-factory/events';
import { AppendRefused, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { IndexedArtifacts, type Picture, PictureIndex } from '../../src/pictures/index.ts';

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('pictures');
});
afterEach(() => database?.end());

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

const shot = (fill: string, version: string, boxed = false): Screenshot => ({
  kind: 'screenshot',
  hash: fill.repeat(64),
  type: 'image/png',
  size: 1000 + fill.charCodeAt(0),
  route: '/about',
  version,
  width: 1280,
  height: 1600,
  boxes: boxed ? [{ x: 10, y: 20, width: 300, height: 40, kind: 'problem' }] : [],
});

const picture = (path: string, boxed = false): Picture => ({
  canary: NEW,
  stable: OLD,
  path,
  route: path,
  before: shot('1', OLD, boxed),
  after: shot('2', NEW, boxed),
  changed: 0.25,
  diff: shot('3', NEW),
  rollout: null,
});

describe('the pictures’ index', () => {
  it('records a canary’s pages once, and gives them back by canary and stable version', async () => {
    const index = new PictureIndex(database.writer);
    expect(await index.taken(NEW, OLD)).toBe(false);
    await index.record([picture('/about'), picture('/')]);
    await index.record([{ ...picture('/'), changed: 0.5 }]);
    expect(await index.taken(NEW, OLD)).toBe(true);
    expect(await index.taken(NEW, 'c'.repeat(40))).toBe(false);
    const pages = await index.of(NEW, OLD);
    expect(pages.map((p) => [p.path, p.changed])).toEqual([
      ['/', 0.25],
      ['/about', 0.25],
    ]);
    expect(pages[1]).toEqual(picture('/about'));
  });

  it('adds a page after the rollout once, only to a page with a box', async () => {
    const index = new PictureIndex(database.writer);
    await index.record([picture('/about', true), picture('/')]);
    const waiting = await index.awaitingRollout(NEW);
    expect(waiting.map((p) => p.path)).toEqual(['/about']);
    await index.rolledOut(picture('/about'), shot('4', NEW, true));
    await index.rolledOut(picture('/about'), shot('5', NEW, true));
    expect(await index.awaitingRollout(NEW)).toEqual([]);
    expect((await index.of(NEW, OLD))[1]?.rollout?.hash).toBe('4'.repeat(64));
  });

  it('remembers where a check last boxed what it found, and forgets a look long gone', async () => {
    const index = new PictureIndex(database.writer);
    const look = {
      sense: 'probe' as const,
      check: 'product/price',
      route: '/products/:slug',
      path: '/products/glove-left',
      elements: [{ selector: 'main h1', kind: 'problem' as const }],
    };
    const now = new Date('2026-10-11T09:00:00Z');
    await index.remember(look, new Date('2026-08-01T09:00:00Z'));
    expect(await index.looks(now)).toEqual([]);
    await index.remember({ ...look, path: '/products/glove-right' }, now);
    expect(await index.looks(now)).toEqual([{ ...look, path: '/products/glove-right' }]);
    expect(await index.lookOf('probe', 'product/price', '/products/:slug')).toEqual({
      ...look,
      path: '/products/glove-right',
    });
    expect(await index.lookOf('crawler', 'product/price', '/products/:slug')).toBeUndefined();
  });

  it('lets the factory’s writer change nothing of a picture but its rollout', async () => {
    await new PictureIndex(database.writer).record([picture('/about')]);
    await expect(database.writer`update pictures set changed = 0`).rejects.toThrow(/permission denied/);
    await expect(database.writer`delete from pictures`).rejects.toThrow(/permission denied/);
  });
});

describe('the artifacts the line may attach', () => {
  it('are the pictures the index knows, at their size, and nothing else', async () => {
    await new PictureIndex(database.writer).record([picture('/about')]);
    const artifacts = new IndexedArtifacts(database.writer);
    expect(await artifacts.size('2'.repeat(64))).toBe(1000 + '2'.charCodeAt(0));
    expect(await artifacts.size('3'.repeat(64))).toBe(1000 + '3'.charCodeAt(0));
    expect(await artifacts.size('9'.repeat(64))).toBeNull();
    await expect(artifacts.put()).rejects.toThrow(/no artifacts of its own/);

    const events = new EventWriter(database.writer, { kind: 'real', artifacts });
    const workItem = await nextWorkItem(database.writer);
    const opened = (artifacts: Screenshot[]): NewEvent => ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type: 'work-item.opened',
      version: VERSIONS['work-item.opened'],
      actor: 'triage',
      summary: 'Opened for the test',
      payload: { kind: 'defect-fix', title: 'A page', sample: false },
      artifacts,
    });
    await expect(events.append(opened([shot('9', NEW)]))).rejects.toBeInstanceOf(AppendRefused);
    await events.append(opened([shot('1', OLD), shot('2', NEW)]));
  });
});
