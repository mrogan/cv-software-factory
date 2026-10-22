/**
 * Who a request comes from, as far as the rate limits are concerned, and the limits themselves.
 *
 * The client's address is the connection's, unless the connection comes from the proxy in front: then it is the last
 * address in `X-Forwarded-For` that is not one of the proxy's, which is the one the proxy itself saw. Anything to its
 * left was written by the client and proves nothing. From anywhere else, forwarded headers are ignored.
 */
import type { IncomingMessage } from 'node:http';
import { type BlockList, isIP } from 'node:net';

/** The address a request comes from, believing forwarded headers only from the proxy in front. */
export function clientAddress(req: IncomingMessage, trusted: BlockList): string {
  const peer = normal(req.socket.remoteAddress ?? '');
  if (!isTrusted(peer, trusted)) return peer;
  const header = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((hop) => normal(hop.trim()))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i] as string;
    // A hop that is no address at all is the client's own writing: nothing to its left can be believed either.
    if (!isIP(hop)) return peer;
    if (!isTrusted(hop, trusted)) return hop;
  }
  return peer;
}

/** An IPv4 address a dual-stack socket reports as `::ffff:10.0.0.1`, as itself. */
const normal = (address: string) =>
  address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;

function isTrusted(address: string, trusted: BlockList): boolean {
  const family = isIP(address);
  return family !== 0 && trusted.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export interface Limit {
  /** How many requests one address may make in a window. */
  requests: number;
  minutes: number;
}

/**
 * Enrolment and signing in, limited by client address. Each ceremony is two requests (its options, then the
 * passkey's answer), so enrolment allows five ceremonies a window, as many as a code's tries, and signing in fifteen.
 */
export const LIMITS = {
  enrol: { requests: 10, minutes: 10 },
  'sign-in': { requests: 30, minutes: 10 },
} as const satisfies Record<string, Limit>;

/** The most addresses one limit remembers: past it, the oldest windows are forgotten first. */
const REMEMBERED = 10_000;

/**
 * A fixed window per address, in memory: the admin service runs as one replica, and a restart forgets the counts,
 * which costs an attacker a restart they cannot cause.
 */
export class RateLimit {
  readonly #limit: Limit;
  readonly #now: () => number;
  readonly #windows = new Map<string, { started: number; count: number }>();

  constructor(limit: Limit, now: () => number = Date.now) {
    this.#limit = limit;
    this.#now = now;
  }

  /** Counts a request from this address, and says how many seconds it must wait if it is over the limit. */
  take(address: string): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.#now();
    const span = this.#limit.minutes * 60_000;
    let window = this.#windows.get(address);
    if (!window || now - window.started >= span) {
      this.#windows.delete(address);
      window = { started: now, count: 0 };
      this.#windows.set(address, window);
      this.#forget(now, span);
    }
    window.count++;
    if (window.count <= this.#limit.requests) return { ok: true };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((window.started + span - now) / 1000)) };
  }

  /** Drops windows that have ended, and the oldest past the most it remembers. Maps keep their insertion order. */
  #forget(now: number, span: number) {
    if (this.#windows.size <= REMEMBERED) return;
    for (const [address, window] of this.#windows) {
      if (this.#windows.size <= REMEMBERED && now - window.started < span) break;
      this.#windows.delete(address);
    }
  }
}
