/**
 * The traffic generator: a steady walk through the app's public pages and its search, so that a canary has enough
 * requests to be judged, and the objectives have traffic too. It goes in through the front door, the ingress, so the
 * canary's traffic split applies to it as to any visitor.
 *
 * It only ever GETs: it never sends a report or the contact form, so nothing it does becomes a signal but what the
 * app's own telemetry says about the requests.
 *
 * The walk is the same every round, in the same order, and its length shares no factor with 100. The ingress shares
 * requests between the stable version and the canary by weighted round robin, in a percentage of each hundred: a round
 * whose length shared a factor with that split's period would deal some pages only to one version, and the comparison
 * would be between two different mixes of pages. As it is, every page reaches both versions in proportion, and a
 * route that fails on purpose fails as often in each.
 *
 * Given its key, it sends each request with one of its ids, signed (share.ts), for a flag's share stage: the ids turn
 * one a request, and there are 101 of them, a prime, so a round's length is also made to share no factor with that.
 * Then every page meets every id equally, once in each stretch of the round's length times 101 requests, and so each
 * side of a share gets the same mix of pages. And since 101 shares no factor with 100 either, the ids turn
 * independently of the canary's split: each id reaches both versions in proportion, and a flag left at the share stage
 * gives a canary's two sides the same mix of on and off.
 *
 * It measures each request itself, its status and how long it took, by id, so that Verify can compare a share's two
 * sides on figures the code being judged did not write. Which side an id is on is Verify's to work out, with flagd's
 * own rule; the generator never asks flagd.
 */
import { request } from 'node:http';
import type { Logger } from '../log.ts';
import type { RequestHeaders } from '../senses/http.ts';
import { IDS, type Sign } from './share.ts';

/** What the app answered: its status and the page. */
export interface Answer {
  status: number;
  body: string;
}

/** Asks the app for a path and its query, by GET, with these headers besides the usual. */
export type Get = (path: string, headers?: RequestHeaders) => Promise<Answer>;

/** The most pages the walk finds: the app has about forty, with its product list's pages and departments. */
const MOST_PAGES = 200;

/** Same-origin links on a page, as paths with their queries. Assets and fragments are not pages to walk. */
export function linksOn(body: string): string[] {
  const base = 'http://app';
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
 * The app's pages, as a visitor finds them from the front door: every page its links lead to, breadth first, then a
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

/**
 * The walk as one round, made a length that shares no factor with 100, nor with the number of ids, by visiting the
 * front door again.
 */
export function round(pages: readonly string[]): string[] {
  const walk = pages.length ? [...pages] : ['/'];
  while (gcd(walk.length, 100) !== 1 || gcd(walk.length, IDS.length) !== 1) walk.push('/');
  return walk;
}

/** One request the generator sent, as it measured it. */
export interface Sent {
  /** Its status, or null when no answer came. */
  status: number | null;
  /** How long it took, from sending it to the end of the answer, or to giving up. */
  seconds: number;
  /** The id it was sent with, or null when the generator has no key. */
  id: string | null;
}

export interface TrafficOptions {
  get: Get;
  /** Requests a second. */
  rate: number;
  log: Logger;
  /** How often the walk is found again, so a release's new pages join it. */
  rediscoverMs?: number;
  /** Signs each request with an id. Without it, no id is sent. */
  sign?: Sign;
  /** Called with each request the walk sent, as it was answered. */
  sent?: (request: Sent) => void;
}

/**
 * Asks for the walk's pages, one after another, at a steady rate, until stopped. A request is sent on time whether or
 * not the last has been answered, so a slow page does not slow the traffic down.
 */
export class Traffic {
  readonly #options: Required<Omit<TrafficOptions, 'sent' | 'sign'>> & Pick<TrafficOptions, 'sent' | 'sign'>;
  #walk: string[] = ['/'];
  #next = 0;
  /** The next id's place in IDS. It turns on its own, whatever the walk does. */
  #nextId = 0;
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
    // An app that could not be walked, in the middle of a release, say, keeps the walk it had: the front door, at least.
    if (!pages.length) return void this.#options.log.warn('could not find the app’s pages; walking the ones it had');
    const walk = round(pages);
    if (walk.join() !== this.#walk.join()) {
      this.#options.log.info({ pages: pages.length, round: walk.length }, 'walking the app’s pages');
      this.#walk = walk;
      this.#next = 0;
    }
  }

  #send(): void {
    const path = this.#walk[this.#next % this.#walk.length] as string;
    this.#next = (this.#next + 1) % this.#walk.length;
    const { sign } = this.#options;
    const id = sign ? (IDS[this.#nextId] as string) : null;
    this.#nextId = (this.#nextId + 1) % IDS.length;
    const started = performance.now();
    const done = this.#options
      .get(path, id && sign ? sign(id, path) : undefined)
      .then(
        (answer) => answer.status,
        () => null,
      )
      .then((status) => {
        this.#options.sent?.({ status, seconds: (performance.now() - started) / 1000, id });
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

export interface GetOptions {
  /** The ingress's address, to connect to in place of the app's. */
  ingress?: string | undefined;
  timeoutMs?: number;
  /** Sent besides the usual. The traffic generator sends none: it stands in for the visitors, who are judged. */
  headers?: RequestHeaders | undefined;
}

/**
 * GETs the app over HTTP. Given the ingress's address, it connects there and names the app's host, as a visitor's
 * browser would through DNS: in the cluster the app's public name is not resolvable, but the ingress is.
 */
export function httpGet(app: string, { ingress, timeoutMs = 10_000, headers }: GetOptions = {}): Get {
  const { host } = new URL(app);
  const to = new URL(ingress ?? app);
  return (path, signed) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          host: to.hostname,
          port: to.port || 80,
          path,
          method: 'GET',
          headers: { 'user-agent': 'software-factory-traffic', ...headers, ...signed, host },
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
