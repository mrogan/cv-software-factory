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
}

/** Two Services and a browser: the canary's `/about` has a new heading; every other page is the same on both. */
function setup() {
  const versions: Record<string, string> = { [STABLE]: OLD, [CANARY]: NEW };
  /** Called as each page is pictured, to change a version under the pictures. */
  const during = { shot: () => {} };
  const shots: string[] = [];
  const stored = new Map<string, Uint8Array>();
  const index = new FakeIndex();
  const store = {
    put: async (bytes: Uint8Array) => {
      stored.set(sha256(bytes), bytes);
      return sha256(bytes);
    },
    size: async (hash: string) => stored.get(hash)?.byteLength ?? null,
    open: async () => null,
  };
  const pictures = new Pictures({
    stable: STABLE,
    canary: CANARY,
    version: async (app) => {
      const version = versions[app];
      if (!version) throw new Error(`${app} did not answer`);
      return version;
    },
    pages: async () => ['/', '/about', '/products/glove-left'],
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
        boxes: elements.length ? [{ x: 1, y: 1, width: 10, height: 5, kind: 'problem' }] : [],
      };
      return { png: bytes, screenshot };
    },
    index,
    store,
    log: quiet,
  });
  return { pictures, versions, shots, index, stored, during };
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

    // Promoted: both Services run the canary's version, and the boxed page is pictured once more on the stable.
    versions[STABLE] = NEW;
    expect(await pictures.tick()).toEqual({ rolledOut: 1 });
    expect(shots.at(-1)).toBe('stable /products/glove-left boxed');
    expect(index.pictures[0]?.rollout).toMatchObject({ version: NEW, boxes: [{ kind: 'problem' }] });
    expect(await pictures.tick()).toBeNull();
    expect(shots).toHaveLength(7);
  });
});
