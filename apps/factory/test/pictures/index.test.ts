/**
 * The pictures' index, in Postgres as the factory's writer: what the probes worker records, and what the line reads,
 * including the artifacts it may attach to an event without a way to the store.
 */
import { type NewEvent, type PayloadOf, type Screenshot, VERSIONS } from '@software-factory/events';
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
    expect(await index.pictured(NEW, OLD)).toEqual(new Set());
    await index.record([picture('/about'), picture('/')]);
    await index.record([{ ...picture('/'), changed: 0.5 }]);
    expect(await index.pictured(NEW, OLD)).toEqual(new Set(['/', '/about']));
    expect(await index.pictured(NEW, 'c'.repeat(40))).toEqual(new Set());
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
  });
});

describe('forgetting the pictures no release needs', () => {
  const V1 = '1'.repeat(40);
  const V2 = '2'.repeat(40);
  const V3 = '3'.repeat(40);
  /** A page of a release, its images named by the hex digit each hash repeats: before, after, diff and rollout. */
  const page = (canary: string, stable: string, path: string, [b, a, d, r]: string): Picture => ({
    canary,
    stable,
    path,
    route: path,
    before: shot(b as string, stable),
    after: shot(a as string, canary),
    changed: 0.1,
    diff: d === '-' ? null : shot(d as string, canary),
    rollout: r === '-' ? null : shot(r as string, canary),
  });
  const hash = (fill: string) => fill.repeat(64);
  const event = <K extends NewEvent['type']>(
    workItem: string,
    type: K,
    payload: PayloadOf<K>,
    artifacts: Screenshot[] = [],
  ): NewEvent =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type],
      actor: 'factory',
      summary: `${type} for the test`,
      payload,
      artifacts,
    }) as NewEvent;

  it('keeps the last releases, those Verify waits for, and every image still named; gives back the rest', async () => {
    const index = new PictureIndex(database.writer);
    const forget = async (keep: number) => {
      const removed: string[] = [];
      expect(await index.forget(keep, async (hash) => void removed.push(hash))).toBe(removed.length);
      return removed.sort();
    };
    // Three releases, in order: the first replaced a version never pictured, each later one the one before.
    await index.record([page(V1, OLD, '/', '1234'), page(V1, OLD, '/about', '56--')]);
    await index.record([page(V2, V1, '/', '789-')]);
    await index.record([page(V3, V2, '/', '1ab-')]);
    const events = new EventWriter(database.writer, { kind: 'real', artifacts: new IndexedArtifacts(database.writer) });

    // The second release carried a fix that waits at Verify.
    const waiting = await nextWorkItem(database.writer);
    await events.append([
      event(waiting, 'work-item.opened', { kind: 'defect-fix', title: 'A fix', sample: false }),
      event(waiting, 'release.promoted', {
        release: 'abc123',
        version: V2,
        previous: V1,
        watched: true,
        dryRun: false,
      }),
    ]);
    // The first release's canary picture of / is on an event, and its diff named by a verification's pages.
    const verified = await nextWorkItem(database.writer);
    await events.append([
      event(verified, 'work-item.opened', { kind: 'defect-fix', title: 'Another fix', sample: false }),
      event(verified, 'hold.started', { stage: 'verify', kind: 'held', cause: 'verify', reason: 'Too quiet' }, [
        shot('2', V1),
      ]),
      event(verified, 'verification.finished', {
        outcome: 'cleared',
        check: 'home',
        against: OLD,
        pages: [{ page: '/', route: '/', screenshot: hash('3'), changed: 0.1, intended: true }],
        dryRun: false,
      }),
    ]);
    // Its rollout is on a signal triage has still to take.
    await database.writer`
      insert into inbox (id, sense, fingerprint, signal)
      values (${crypto.randomUUID()}, 'probe', '/ broken-image', ${database.writer.json({ artifacts: [shot('4', V1)] } as never)})`;

    // The first release's / before is the third's too, stored once; its /about is named by nothing.
    expect(await forget(1)).toEqual([hash('5'), hash('6')]);
    expect(await index.of(V1, OLD)).toEqual([]);
    expect(await index.of(V2, V1)).toHaveLength(1);
    expect(await index.of(V3, V2)).toHaveLength(1);
    expect(await forget(1)).toEqual([]);

    // Verified: the second release is needed no more.
    await events.append(
      event(waiting, 'verification.finished', {
        outcome: 'cleared',
        check: 'home',
        against: V1,
        pages: [],
        dryRun: false,
      }),
    );
    expect(await forget(1)).toEqual([hash('7'), hash('8'), hash('9')]);
    expect(await index.of(V2, V1)).toEqual([]);
    expect(await index.of(V3, V2)).toHaveLength(1);
  });

  it('forgets a release Verify returned to Plan, and offers again an image whose removal failed', async () => {
    const index = new PictureIndex(database.writer);
    await index.record([page(V1, OLD, '/', '12--')]);
    await index.record([page(V2, V1, '/', '34--')]);
    const events = new EventWriter(database.writer, { kind: 'real', artifacts: new IndexedArtifacts(database.writer) });
    const returned = await nextWorkItem(database.writer);
    await events.append([
      event(returned, 'work-item.opened', { kind: 'defect-fix', title: 'A fix', sample: false }),
      event(returned, 'release.promoted', {
        release: 'abc123',
        version: V1,
        previous: OLD,
        watched: true,
        dryRun: false,
      }),
    ]);
    const offered: string[] = [];
    expect(await index.forget(1, async (h) => void offered.push(h))).toBe(0);
    await events.append(
      event(returned, 'work.returned', { from: 'verify', to: 'plan', reason: 'Martin sent it back' }),
    );

    await expect(
      index.forget(1, async () => {
        throw new Error('read-only file system');
      }),
    ).rejects.toThrow(/read-only/);
    expect(await index.of(V1, OLD)).toHaveLength(1);
    expect(await index.forget(1, async (h) => void offered.push(h))).toBe(2);
    expect(offered.sort()).toEqual([hash('1'), hash('2')]);
    expect(await index.of(V1, OLD)).toEqual([]);
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
