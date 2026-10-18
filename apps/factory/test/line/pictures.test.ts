import type { Screenshot } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { MOST_PAGES, pagesFor } from '../../src/line/pictures.ts';
import type { Picture, Shot } from '../../src/pictures/index.ts';

const shot = (n: number): Shot => ({
  kind: 'screenshot',
  hash: n.toString(16).padStart(64, '0'),
  type: 'image/png',
  size: 100,
  route: '/',
  version: 'a'.repeat(40),
  width: 1280,
  height: 800,
  boxes: [],
});

const picture = (path: string, route: string, changed: number, n: number): Picture => ({
  canary: 'b'.repeat(40),
  stable: 'a'.repeat(40),
  path,
  route,
  before: shot(n * 2),
  after: shot(n * 2 + 1),
  changed,
  diff: null,
  rollout: null,
});

describe('the pages a verification names', () => {
  const shop = Array.from({ length: 20 }, (_, i) =>
    picture(`/products/p${String(i).padStart(2, '0')}`, '/products/:slug', i === 7 ? 0.5 : 0, i),
  );

  it('names at most twelve, the ticket’s own first, then those that changed most, then by path', () => {
    const { pages, artifacts } = pagesFor(shop, { path: '/products/p13', route: '/products/:slug' });
    expect(pages).toHaveLength(MOST_PAGES);
    expect(pages.slice(0, 3).map((p) => [p.page, p.intended])).toEqual([
      ['/products/p13', true],
      ['/products/p07', false],
      ['/products/p00', false],
    ]);
    expect(artifacts).toHaveLength(2 * MOST_PAGES);
  });

  it('takes every page of the route as the ticket’s own when no box says which, and none for every route', () => {
    const own = pagesFor(shop.slice(0, 3), { route: '/products/:slug' });
    expect(own.pages.map((p) => p.intended)).toEqual([true, true, true]);
    const everywhere = pagesFor(shop.slice(0, 3), { route: '*' });
    expect(everywhere.pages.map((p) => p.intended)).toEqual([false, false, false]);
  });

  it('names the other work item the release carried on its own page, the ticket’s own named by none', () => {
    const pages = [picture('/', '/', 0, 1), picture('/about', '/about', 0.2, 2), picture('/cart', '/cart', 0.1, 3)];
    const shown = pagesFor(pages, { path: '/', route: '/' }, [
      { workItem: '1073', own: { route: '/about' } },
      { workItem: '1074', own: { path: '/about', route: '/about' } },
      { workItem: '1075', own: { route: '/' } },
    ]);
    expect(shown.pages.map((p) => [p.page, p.intended, p.intendedFor])).toEqual([
      ['/', true, undefined],
      ['/about', false, '1073'],
      ['/cart', false, undefined],
    ]);
    expect(shown.pages[2]).not.toHaveProperty('intendedFor');
  });

  describe('the boxes on their screenshots', () => {
    /** A page boxed by two checks: the price's heading, and the cards another finding was about. */
    const boxed = (n: number): Shot => ({
      ...shot(n),
      boxes: [
        { x: 0, y: 100, width: 600, height: 40, kind: 'problem' },
        { x: 0, y: 900, width: 1200, height: 300, kind: 'problem' },
      ],
      selectors: ['main h1', '.cards'],
    });
    const page = (path: string, n: number): Picture => ({
      ...picture(path, '/products/:slug', 0, n),
      before: boxed(n * 2),
      after: boxed(n * 2 + 1),
      rollout: boxed(n * 2 + 100),
    });
    const pages = [page('/products/p01', 1), page('/products/p02', 2)];
    const depths = (artifacts: Screenshot[]) => artifacts.map((a) => a.boxes.map((b) => b.y));

    it('keeps only the ticket’s own check’s, on its own page, and no selector', () => {
      const { artifacts } = pagesFor(pages, {
        path: '/products/p01',
        selectors: ['main h1'],
        route: '/products/:slug',
      });
      expect(depths(artifacts)).toEqual([[100], [100], [], [], [100]]);
      for (const a of artifacts) expect(a).not.toHaveProperty('selectors');
    });

    it('keeps the ticket’s own however many other checks boxed the page before it', () => {
      const crowded = (n: number): Shot => ({
        ...shot(n),
        boxes: [100, 200, 300, 400, 500].map((y) => ({ x: 0, y, width: 600, height: 40, kind: 'problem' as const })),
        selectors: ['nav a', '.cards', 'footer', 'img.hero', 'main h1'],
      });
      const p = { ...picture('/products/p01', '/products/:slug', 0, 1), before: crowded(2), after: crowded(3) };
      const { artifacts } = pagesFor([p], { path: '/products/p01', selectors: ['main h1'], route: '/products/:slug' });
      expect(depths(artifacts)).toEqual([[500], [500]]);
    });

    it('keeps no more boxes than an event takes', () => {
      const many = (n: number): Shot => ({
        ...shot(n),
        boxes: [100, 200, 300, 400, 500].map((y) => ({ x: 0, y, width: 600, height: 40, kind: 'problem' as const })),
      });
      const p = { ...picture('/products/p01', '/products/:slug', 0, 1), before: many(2), after: many(3) };
      const { artifacts } = pagesFor([p], { path: '/products/p01', route: '/products/:slug' });
      expect(depths(artifacts)).toEqual([
        [100, 200, 300, 400],
        [100, 200, 300, 400],
      ]);
    });

    it('keeps none for a ticket whose sense boxes nothing, on any page of its route', () => {
      const { pages: named, artifacts } = pagesFor(pages, { route: '/products/:slug' });
      expect(named.map((p) => p.intended)).toEqual([true, true]);
      // Nor a page after the rollout, which another check's box was the reason for.
      expect(depths(artifacts)).toEqual([[], [], [], []]);
    });

    it('keeps every box on its own page from a picture taken before the boxes kept their selectors', () => {
      const bare = ({ selectors: _, ...screenshot }: Shot): Shot => screenshot;
      const old = pages.map((p) => ({ ...p, before: bare(p.before), after: bare(p.after), rollout: null }));
      const { artifacts } = pagesFor(old, { path: '/products/p01', selectors: ['main h1'], route: '/products/:slug' });
      expect(depths(artifacts)).toEqual([[100, 900], [100, 900], [], []]);
      expect(depths(pagesFor(old, { route: '/products/:slug' }).artifacts)).toEqual([[], [], [], []]);
    });
  });
});
