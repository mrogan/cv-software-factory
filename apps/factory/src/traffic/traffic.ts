/**
 * The traffic generator: a steady walk through the shop's public pages and its search, so that a canary has enough
 * requests to be judged, and the objectives have traffic too. It goes in through the front door, the ingress, so the
 * canary's traffic split applies to it as to any visitor.
 *
 * It only ever GETs: it never sends a report or the contact form, so nothing it does becomes a signal but what the
 * shop's own telemetry says about the requests.
 *
 * The walk is the same every round, in the same order, and its length shares no factor with 100. The ingress shares
 * requests between the stable version and the canary by weighted round robin, in a percentage of each hundred: a round
 * whose length shared a factor with that split's period would deal some pages only to one version, and the comparison
 * would be between two different mixes of pages. As it is, every page reaches both versions in proportion, and a
 * route that fails on purpose fails as often in each.
 */
import { request } from 'node:http';
import type { Logger } from '../log.ts';

/** What the shop answered: its status and the page. */
export interface Answer {
  status: number;
  body: string;
}

/** Asks the shop for a path and its query, by GET. */
export type Get = (path: string) => Promise<Answer>;

/** The most pages the walk finds: the shop has about forty, with its product list's pages and departments. */
const MOST_PAGES = 200;

/** Same-origin links on a page, as paths with their queries. Assets and fragments are not pages to walk. */
export function linksOn(body: string): string[] {
  const base = 'http://shop';
  const paths: string[] = [];
  for (const [, href] of body.matchAll(/<a\s[^>]*?href="([^"]*)"/g)) {
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href.replaceAll('&amp;', '&'), `${base}/`);
    } catch {
      continue;
    }
    if (url.origin === base && !url.pathname.startsWith('/assets/')) paths.push(`${url.pathname}${url.search}`);
  }
  return paths;
}

/**
 * The shop's pages, as a visitor finds them from the front door: every page its links lead to, breadth first, then a
 * search for the first word of each product's address. A page that answers badly is still a page: it is walked, but
 * its links are not followed. A front door that answers badly leads nowhere, and finds nothing.
 */
export async function discover(get: Get): Promise<string[]> {
  const pages = ['/'];
  for (let i = 0; i < pages.length && pages.length < MOST_PAGES; i++) {
    const answer = await get(pages[i] as string).catch(() => undefined);
    if (i === 0 && answer?.status !== 200) return [];
    if (answer?.status !== 200) continue;
    for (const path of linksOn(answer.body)) if (!pages.includes(path) && pages.length < MOST_PAGES) pages.push(path);
  }
  const words = pages.flatMap((path) => path.match(/^\/products\/([a-z0-9]+)/)?.[1] ?? []);
  return [...pages, ...[...new Set(words)].map((word) => `/search?q=${encodeURIComponent(word)}`)];
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** The walk as one round, made a length that shares no factor with 100 by visiting the front door again. */
export function round(pages: readonly string[]): string[] {
  const walk = pages.length ? [...pages] : ['/'];
  while (gcd(walk.length, 100) !== 1) walk.push('/');
  return walk;
}

export interface TrafficOptions {
  get: Get;
  /** Requests a second. */
  rate: number;
  log: Logger;
  /** How often the walk is found again, so a release's new pages join it. */
  rediscoverMs?: number;
  /** Called with each request's status, or null when none came. */
  sent?: (status: number | null) => void;
}

/**
 * Asks for the walk's pages, one after another, at a steady rate, until stopped. A request is sent on time whether or
 * not the last has been answered, so a slow page does not slow the traffic down.
 */
export class Traffic {
  readonly #options: Required<Omit<TrafficOptions, 'sent'>> & Pick<TrafficOptions, 'sent'>;
  #walk: string[] = ['/'];
  #next = 0;
  #timers: NodeJS.Timeout[] = [];
  readonly #inFlight = new Set<Promise<void>>();
  #tally = new Map<string, number>();

  constructor(options: TrafficOptions) {
    this.#options = { rediscoverMs: 10 * 60_000, ...options };
  }

  /** The round being walked. */
  get walk(): readonly string[] {
    return this.#walk;
  }

  /** Finds the walk, then sends its requests at the rate, and finds the walk again every so often. */
  async start(): Promise<void> {
    await this.#rediscover();
    const { rate, rediscoverMs } = this.#options;
    this.#timers = [
      setInterval(() => this.#send(), 1000 / rate),
      setInterval(() => void this.#rediscover(), rediscoverMs),
      setInterval(() => this.#report(), 60_000),
    ];
  }

  /** Stops sending, and waits for the requests in flight. */
  async stop(): Promise<void> {
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers = [];
    await Promise.all(this.#inFlight);
    this.#report();
  }

  async #rediscover(): Promise<void> {
    const pages = await discover(this.#options.get).catch(() => []);
    // A shop that could not be walked, in the middle of a release, say, keeps the walk it had: the front door, at least.
    if (!pages.length) return void this.#options.log.warn('could not find the shop’s pages; walking the ones it had');
    const walk = round(pages);
    if (walk.join() !== this.#walk.join()) {
      this.#options.log.info({ pages: pages.length, round: walk.length }, 'walking the shop’s pages');
      this.#walk = walk;
      this.#next = 0;
    }
  }

  #send(): void {
    const path = this.#walk[this.#next % this.#walk.length] as string;
    this.#next = (this.#next + 1) % this.#walk.length;
    const done = this.#options
      .get(path)
      .then(
        (answer) => answer.status,
        () => null,
      )
      .then((status) => {
        this.#options.sent?.(status);
        const key = status === null ? 'no answer' : `${Math.floor(status / 100)}xx`;
        this.#tally.set(key, (this.#tally.get(key) ?? 0) + 1);
      })
      .finally(() => this.#inFlight.delete(done));
    this.#inFlight.add(done);
  }

  #report(): void {
    if (!this.#tally.size) return;
    this.#options.log.info(Object.fromEntries(this.#tally), 'requests sent in the last minute, by answer');
    this.#tally = new Map();
  }
}

/**
 * GETs the shop over HTTP. Given the ingress's address, it connects there and names the shop's host, as a visitor's
 * browser would through DNS: in the cluster the shop's public name is not resolvable, but the ingress is.
 */
export function httpGet(app: string, ingress?: string, timeoutMs = 10_000): Get {
  const shop = new URL(app);
  const to = new URL(ingress ?? app);
  return (path) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: to.hostname,
          port: to.port || 80,
          path,
          method: 'GET',
          headers: { host: shop.host, 'user-agent': 'software-factory-traffic' },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      req.on('error', reject);
      req.end();
    });
}
