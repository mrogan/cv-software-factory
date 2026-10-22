/**
 * The admin service's settings, from its environment. Everything a check compares a request with comes from here and
 * never from the request: the console's origin, which `Origin` must match exactly and WebAuthn's ceremonies must name,
 * the relying party a passkey belongs to, and the proxies whose forwarded headers are believed.
 *
 * - ADMIN_ORIGIN: the console's origin as the browser sees it, such as `https://console.localhost:8443`. Required, and
 *   `https` but for `localhost` itself, as WebAuthn requires.
 * - ADMIN_RP_ID: the relying party's id, a passkey's host; by default the origin's host name.
 * - ADMIN_TRUSTED_PROXIES: the addresses, or CIDR ranges, of the proxy in front (Traefik's, locally), comma-separated.
 *   `X-Forwarded-For` is believed from these alone; with none, it never is.
 * - PORT: where it listens (8080).
 */
import { BlockList, isIP } from 'node:net';

export interface AdminConfig {
  origin: string;
  rpId: string;
  /** Whether a connection comes from the proxy in front, whose forwarded headers are believed. */
  trusted: BlockList;
  port: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv): AdminConfig {
  const given = env.ADMIN_ORIGIN;
  if (!given) throw new Error("Set ADMIN_ORIGIN to the console's origin, such as https://console.localhost:8443.");
  let url: URL;
  try {
    url = new URL(given);
  } catch {
    throw new Error(`ADMIN_ORIGIN is not a URL: ${given}`);
  }
  // Exactly an origin: a path, a query or a trailing slash would never match a browser's `Origin`.
  if (url.origin !== given) throw new Error(`ADMIN_ORIGIN is an origin alone, such as ${url.origin}: not ${given}`);
  if (url.protocol !== 'https:' && url.hostname !== 'localhost') {
    throw new Error(`ADMIN_ORIGIN must be https: a passkey and a secure cookie need it (${given})`);
  }
  const rpId = env.ADMIN_RP_ID || url.hostname;
  // The relying party is the origin's host or a domain it is under, as WebAuthn allows.
  if (url.hostname !== rpId && !url.hostname.endsWith(`.${rpId}`)) {
    throw new Error(`ADMIN_RP_ID ${rpId} is not ${url.hostname} or a domain it is under`);
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT is not a port: ${env.PORT}`);
  return { origin: url.origin, rpId, trusted: proxies(env.ADMIN_TRUSTED_PROXIES ?? ''), port };
}

/** The proxies in front, as `10.42.0.0/16, 127.0.0.1`. */
export function proxies(list: string): BlockList {
  const blocks = new BlockList();
  for (const entry of list
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const [address = '', bits] = entry.split('/');
    const family = isIP(address);
    if (!family) throw new Error(`ADMIN_TRUSTED_PROXIES: ${entry} is not an address or a range`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) {
      blocks.addAddress(address, type);
      continue;
    }
    const prefix = Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 6 ? 128 : 32)) {
      throw new Error(`ADMIN_TRUSTED_PROXIES: ${entry} has no valid prefix`);
    }
    blocks.addSubnet(address, prefix, type);
  }
  return blocks;
}
