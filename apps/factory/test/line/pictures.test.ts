import type { Screenshot } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { MOST_PAGES, pagesFor } from '../../src/line/pictures.ts';
import type { Picture } from '../../src/pictures/index.ts';

const shot = (n: number): Screenshot => ({
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
});
