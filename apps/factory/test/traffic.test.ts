import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, discover, type Get, httpGet, linksOn, round, Traffic } from '../src/traffic/traffic.ts';

const page = (...links: string[]) =>
  `<main>${links.map((href) => `<a class="x" href="${href}">a</a>`).join('')}</main>`;

/** A shop of a few pages, one of which fails on purpose, with what was asked for. */
function shop(asked: string[] = []): Get {
  const pages: Record<string, Answer> = {
    '/': { status: 200, body: page('/', '/products', '/about', 'https://elsewhere.example/', '#main') },
    '/products': {
      status: 200,
      body: page('/products/glove-left', '/products/duster-feather', '/products?page=2', '/assets/site.css'),
    },
    '/products?page=2': { status: 200, body: page('/products/glove-right') },
    '/about': { status: 200, body: page('/contact') },
    '/contact': { status: 200, body: '<form method="post" action="/contact"></form>' },
    '/products/glove-left': { status: 200, body: page('/products') },
    '/products/glove-right': { status: 200, body: '' },
    '/products/duster-feather': { status: 500, body: page('/never-followed') },
  };
  return async (path) => {
    asked.push(path);
    return pages[path] ?? { status: 404, body: '' };
  };
}

describe('the walk', () => {
  it('follows the shop’s own links only: not another site, an asset or a place on the page', () => {
    expect(linksOn(page('/a', 'b?c=1&amp;d=2', 'https://elsewhere.example/x', '/assets/site.css', '#main'))).toEqual([
      '/a',
      '/b?c=1&d=2',
      '/',
    ]);
  });

  it('finds every page from the front door, and searches for each product', async () => {
    expect(await discover(shop())).toEqual([
      '/',
      '/products',
      '/about',
      '/products/glove-left',
      '/products/duster-feather',
      '/products?page=2',
      '/contact',
      '/products/glove-right',
      '/search?q=glove',
      '/search?q=duster',
    ]);
  });

  it('walks a page that fails, without following its links', async () => {
    const asked: string[] = [];
    const pages = await discover(shop(asked));
    expect(pages).toContain('/products/duster-feather');
    expect(pages).not.toContain('/never-followed');
  });

  it('finds nothing when the front door answers badly', async () => {
    expect(await discover(async () => ({ status: 503, body: page('/products') }))).toEqual([]);
    expect(await discover(() => Promise.reject(new Error('reset')))).toEqual([]);
  });

  it('makes a round whose length shares no factor with 100, with the front door', () => {
    for (let length = 0; length <= 120; length++) {
      const walk = round(Array.from({ length }, (_, i) => `/page/${i}`));
      expect([2, 5].some((factor) => walk.length % factor === 0)).toBe(false);
      expect(walk.slice(length).every((path) => path === '/')).toBe(true);
    }
  });

  it('deals every page to the canary alike under a split of a quarter or a half', () => {
    // The ingress's split sends one request in every `period` to the canary, at the same place each time.
    const toCanary = (walk: string[], period: number) => {
      const requests = Array.from({ length: walk.length * period }, (_, i) => walk[i % walk.length]);
      return requests.filter((_, i) => i % period === period - 1);
    };
    const pages = Array.from({ length: 40 }, (_, i) => `/page/${i}`);
    // Forty pages, as the shop has: walked as they are, a quarter would send the canary only every fourth page.
    expect(new Set(toCanary(pages, 4)).size).toBe(10);
    const walk = round(pages);
    for (const period of [4, 2]) {
      const canary = toCanary(walk, period);
      expect(canary).toHaveLength(walk.length);
      expect(new Set(canary)).toEqual(new Set(walk));
    }
  });
});

describe('the traffic', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('asks for the walk’s pages in turn, at the rate, whether or not the last has answered', async () => {
    vi.useFakeTimers();
    const asked: string[] = [];
    const get = shop();
    let walking = false;
    const traffic = new Traffic({
      rate: 5,
      log: pino({ level: 'silent' }),
      get: (path) => {
        if (!walking) return get(path);
        asked.push(path);
        return new Promise(() => {}); // never answers
      },
    });
    await traffic.start();
    walking = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(asked).toHaveLength(50);
    expect(asked).toEqual(Array.from({ length: 50 }, (_, i) => traffic.walk[i % traffic.walk.length]));
  });

  it('keeps the walk it had when the shop cannot be walked again', async () => {
    vi.useFakeTimers();
    const get = shop();
    let down = false;
    const traffic = new Traffic({
      rate: 5,
      log: pino({ level: 'silent' }),
      rediscoverMs: 60_000,
      get: (path) => (down ? Promise.resolve({ status: 503, body: '' }) : get(path)),
    });
    await traffic.start();
    const walk = [...traffic.walk];
    expect(walk.length).toBeGreaterThan(1);
    down = true;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(traffic.walk).toEqual(walk);
  });

  it('counts what answered, and stops once the requests in flight have', async () => {
    vi.useFakeTimers();
    const statuses: (number | null)[] = [];
    const get = shop();
    const traffic = new Traffic({
      rate: 5,
      log: pino({ level: 'silent' }),
      get: (path) => (path === '/about' ? Promise.reject(new Error('reset')) : get(path)),
      sent: (status) => statuses.push(status),
    });
    await traffic.start();
    await vi.advanceTimersByTimeAsync(1_000 * Math.ceil(traffic.walk.length / 5));
    await traffic.stop();
    expect(statuses).toContain(200);
    expect(statuses).toContain(500);
    expect(statuses).toContain(null);
    const sent = statuses.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(statuses).toHaveLength(sent);
  });
});

describe('asking the shop', () => {
  it('connects to the ingress and names the shop, by GET', async () => {
    const seen: { method: string | undefined; url: string | undefined; headers: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers });
      res.writeHead(200).end('<p>hello</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const get = httpGet('http://website.localhost', `http://127.0.0.1:${port}`);
      expect(await get('/search?q=glove')).toEqual({ status: 200, body: '<p>hello</p>' });
      expect(seen).toEqual([
        expect.objectContaining({
          method: 'GET',
          url: '/search?q=glove',
          headers: expect.objectContaining({ host: 'website.localhost' }),
        }),
      ]);
    } finally {
      server.close();
    }
  });

  it('gives up on a shop that does not answer', async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(httpGet(`http://127.0.0.1:${port}`, undefined, 50)('/')).rejects.toThrow('no answer within 50 ms');
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
