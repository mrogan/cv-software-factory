/**
 * The pictures of a release, against stand-ins for the two Services, the browser and the index: which pages are
 * paired, when they are taken, and when they are not.
 */
import type { Screenshot } from '@software-factory/events';
import { sha256 } from '@software-factory/store';
import { describe, expect, it } from 'vitest';
import type { Look, Picture } from '../../src/pictures/index.ts';
import { Pictures, type PicturesOptions, TRIES } from '../../src/pictures/take.ts';
import { quiet } from '../github/fake.ts';
import { png } from './images.ts';

const STABLE = 'http://website.website';
const CANARY = 'http://website-canary.website';
const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

type Index = PicturesOptions['index'];

class FakeIndex implements Index {
  readonly pictures: Picture[] = [];
  looked: Look[] = [];

  async pictured(canary: string, stable: string) {
    return new Set(this.pictures.filter((p) => p.canary === canary && p.stable === stable).map((p) => p.path));
  }

  async record(pictures: readonly Picture[]) {
    this.pictures.push(...pictures);
  }

  async awaitingRollout(version: string) {
    return this.pictures.filter((p) => p.canary === version && !p.rollout && p.after.boxes.length);
  }

  async rolledOut(picture: Pick<Picture, 'canary' | 'stable' | 'path'>, shot: Screenshot) {
    const found = this.pictures.find((p) => p.canary === picture.canary && p.path === picture.path);
    if (found && !found.rollout) found.rollout = shot;
  }

  async looks() {
    return this.looked;
  }

  /** The releases forgotten, as the most kept each time; and the images to delete, as the index would give them. */
  readonly forgot: number[] = [];
  unnamed: string[] = [];

  async forget(keep: number, _stable: string, remove: (hash: string) => Promise<boolean>) {
    this.forgot.push(keep);
    for (const hash of this.unnamed) await remove(hash);
    return this.unnamed.length;
  }
}

/** Two Services and a browser: the canary's `/about` has a new heading; every other page is the same on both. */
function setup() {
  const versions: Record<string, string> = { [STABLE]: OLD, [CANARY]: NEW };
  /** Called as each page is pictured, to change a version under the pictures. */
  const during = { shot: () => {} };
  /** Whether the stable's front door answers, for the pages to be found. */
  const front = { answers: true };
  const shots: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const removed: Date[] = [];
  const index = new FakeIndex();
  const store = {
    put: async (bytes: Uint8Array) => {
      stored.set(sha256(bytes), bytes);
      return sha256(bytes);
    },
    size: async (hash: string) => stored.get(hash)?.byteLength ?? null,
    open: async () => null,
    remove: async (hash: string, unusedSince: Date) => {
      removed.push(unusedSince);
      return stored.delete(hash);
    },
  };
  const pictures = new Pictures({
    stable: STABLE,
    canary: CANARY,
    version: async (app) => {
      const version = versions[app];
      if (!version) throw new Error(`${app} did not answer`);
      return version;
    },
    pages: async () => (front.answers ? ['/', '/about', '/products/glove-left'] : []),
    shoot: async (app, path, { route, version, elements }) => {
      shots.push(`${app === STABLE ? 'stable' : 'canary'} ${path}${elements.length ? ' boxed' : ''}`);
      during.shot();
      const changed = app === CANARY && path === '/about';
      const bytes = changed ? png(40, 30, { x: 0, y: 0, width: 40, height: 3, rgb: [0, 0, 0] }) : png(40, 30);
      const screenshot: Screenshot = {
        kind: 'screenshot',
        hash: await store.put(bytes),
        type: 'image/png',
        size: bytes.byteLength,
        route,
        version,
        width: 40,
        height: 30,
        boxes: elements.slice(0, 1).map(() => ({ x: 1, y: 1, width: 10, height: 5, kind: 'problem' as const })),
      };
      return { png: bytes, screenshot, selectors: elements.slice(0, 1).map((e) => e.selector) };
    },
    index,
    store,
    keepReleases: 2,
    log: quiet,
    now: () => new Date('2026-10-11T09:00:00Z'),
  });
  return { pictures, versions, shots, index, stored, removed, during, front };
}

describe('the pictures of a canary', () => {
  it('pictures each page on the stable and on the canary, and compares each pair', async () => {
    const { pictures, shots, index, stored } = setup();
    expect(await pictures.tick()).toEqual({ compared: 3 });
    expect(shots).toEqual([
      'stable /',
      'canary /',
      'stable /about',
      'canary /about',
      'stable /products/glove-left',
      'canary /products/glove-left',
    ]);
    expect(index.pictures.map((p) => [p.path, p.route, p.changed, p.diff !== null])).toEqual([
      ['/', '/', 0, false],
      ['/about', '/about', 0.1, true],
      ['/products/glove-left', '/products/glove-left', 0, false],
    ]);
    const about = index.pictures[1] as Picture;
    expect(about).toMatchObject({ canary: NEW, stable: OLD, before: { version: OLD }, after: { version: NEW } });
    // The diff is in the store, named as the canary's picture of the page is.
    expect(about.diff).toMatchObject({ route: '/about', version: NEW, width: 40, height: 30, boxes: [] });
    expect(stored.has(about.diff?.hash as string)).toBe(true);
  });

  it('pictures a canary once against the version it replaces, and a new canary again', async () => {
    const { pictures, versions, shots } = setup();
    await pictures.tick();
    expect(await pictures.tick()).toBeNull();
    expect(shots).toHaveLength(6);
    versions[CANARY] = 'c'.repeat(40);
    expect(await pictures.tick()).toEqual({ compared: 3 });
    expect(shots).toHaveLength(12);
  });

  it('finds a canary pictured already in the index, and takes nothing', async () => {
    const first = setup();
    await first.pictures.tick();
    const second = setup();
    second.index.pictures.push(...first.index.pictures);
    expect(await second.pictures.tick()).toBeNull();
    expect(second.shots).toEqual([]);
  });

  it('takes none between releases, when both Services run the same version, or when one does not answer', async () => {
    const { pictures, versions, shots } = setup();
    versions[CANARY] = OLD;
    expect(await pictures.tick()).toBeNull();
    delete versions[CANARY];
    expect(await pictures.tick()).toBeNull();
    expect(shots).toEqual([]);
  });

  it('keeps the pages taken before a version moved, drops the one it moved during, and takes the rest later', async () => {
    const { pictures, versions, shots, index, during } = setup();
    // A rollback starts while /about is pictured: for a moment the stable Service answers otherwise.
    during.shot = () => {
      if (shots.length === 4) versions[STABLE] = NEW;
    };
    expect(await pictures.tick()).toEqual({ compared: 1 });
    expect(index.pictures.map((p) => p.path)).toEqual(['/']);
    versions[STABLE] = OLD;
    expect(await pictures.tick()).toEqual({ compared: 2 });
    expect(index.pictures.map((p) => p.path)).toEqual(['/', '/about', '/products/glove-left']);
    expect(shots).toHaveLength(8);
    expect(await pictures.tick()).toBeNull();
    expect(shots).toHaveLength(8);
  });

  it('tries again when no page could be found, rather than taking the canary as pictured', async () => {
    const { pictures, shots, front } = setup();
    front.answers = false;
    expect(await pictures.tick()).toBeNull();
    front.answers = true;
    expect(await pictures.tick()).toEqual({ compared: 3 });
    expect(shots).toHaveLength(6);
  });

  it('gives up on a canary after a few passes that each saw a version move', async () => {
    const { pictures, versions, shots, index, during } = setup();
    during.shot = () => {
      if (shots.length % 2 === 0) versions[STABLE] = NEW;
    };
    for (let i = 0; i < TRIES; i++) {
      versions[STABLE] = OLD;
      expect(await pictures.tick()).toBeNull();
    }
    expect(index.pictures).toEqual([]);
    versions[STABLE] = OLD;
    expect(await pictures.tick()).toBeNull();
    expect(shots).toHaveLength(2 * TRIES);
  });

  it('boxes what a sense found on its page, on both versions, and pictures it again after the rollout', async () => {
    const { pictures, versions, shots, index } = setup();
    index.looked = [
      {
        sense: 'probe',
        check: 'product/price',
        route: '/products/:slug',
        path: '/products/glove-left',
        elements: [{ selector: 'main h1', kind: 'problem' }],
      },
    ];
    await pictures.tick();
    // The page a sense boxed comes first, named by the sense's route.
    expect(shots.slice(0, 2)).toEqual(['stable /products/glove-left boxed', 'canary /products/glove-left boxed']);
    expect(index.pictures[0]).toMatchObject({ path: '/products/glove-left', route: '/products/:slug', rollout: null });
    // Each box keeps the selector it was drawn round, for the line to tell a ticket's own from another's.
    expect(index.pictures[0]?.after).toMatchObject({ boxes: [{ kind: 'problem' }], selectors: ['main h1'] });

    // Promoted: both Services run the canary's version, and the boxed page is pictured once more on the stable.
    versions[STABLE] = NEW;
    expect(await pictures.tick()).toEqual({ rolledOut: 1 });
    expect(shots.at(-1)).toBe('stable /products/glove-left boxed');
    expect(index.pictures[0]?.rollout).toMatchObject({
      version: NEW,
      boxes: [{ kind: 'problem' }],
      selectors: ['main h1'],
    });
    expect(await pictures.tick()).toBeNull();
    expect(shots).toHaveLength(7);
  });

  it('deletes what no release needs between releases, after the rollout’s pages, once for each stable version', async () => {
    const { pictures, versions, index, stored, removed } = setup();
    index.looked = [
      { sense: 'probe', check: 'home', route: '/', path: '/', elements: [{ selector: 'h1', kind: 'problem' }] },
    ];
    await pictures.tick();
    // While a canary runs, nothing is forgotten.
    expect(index.forgot).toEqual([]);
    const [old] = [...stored.keys()];
    index.unnamed = [old as string];

    // Promoted: the page after the rollout first, then the pictures no release needs.
    versions[STABLE] = NEW;
    expect(await pictures.tick()).toEqual({ rolledOut: 1 });
    expect(index.forgot).toEqual([]);
    expect(await pictures.tick()).toEqual({ deleted: 1 });
    expect(index.forgot).toEqual([2]);
    expect(stored.has(old as string)).toBe(false);
    // Only if it was not stored again in the ten minutes before.
    expect(removed).toEqual([new Date('2026-10-11T08:50:00Z')]);
    expect(await pictures.tick()).toBeNull();
    expect(index.forgot).toEqual([2]);

    // The next release, once promoted, forgets again.
    index.unnamed = [];
    versions[CANARY] = 'c'.repeat(40);
    await pictures.tick();
    versions[STABLE] = 'c'.repeat(40);
    await pictures.tick();
    await pictures.tick();
    expect(index.forgot).toEqual([2, 2]);
  });

  it('forgets between releases when the canary Service does not answer', async () => {
    const { pictures, versions, index } = setup();
    delete versions[CANARY];
    expect(await pictures.tick()).toBeNull();
    expect(index.forgot).toEqual([2]);
    expect(await pictures.tick()).toBeNull();
    expect(index.forgot).toEqual([2]);
  });
});
