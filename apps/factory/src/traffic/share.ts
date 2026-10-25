/**
 * The traffic generator's signed ids, for a flag's share stage (milestone 7): the app turns a flag on for a share of
 * the generator's requests, chosen by flagd's `fractional` rule over the id each one carries. The id is signed, with an
 * Ed25519 key only the generator holds, so that nobody else can walk into the share by sending an id; the app holds
 * only the public key, in the ConfigMap `share-key`, and ignores an id without a good signature. The ids themselves
 * are harmless, and may be metric labels; a signature is a bearer credential for its page and its minute, so it goes
 * in the request's headers and nowhere else: never a log, a span or a metric.
 *
 * The message signed, and the headers, are a contract with the app's flag context, written down in
 * docs/COMPONENTS/FEATURE-FLAGS.md with a test vector that apps/factory/test/share.test.ts holds this code to.
 */
import { createPrivateKey, type KeyObject, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { RequestHeaders } from '../senses/http.ts';

/** The first field of every message, so that a signature made with this key means this and nothing else. */
export const CONTEXT = 'software-factory share-id v1';

/** The headers a signed request carries, by lower-case name. */
export const HEADERS = { id: 'x-share-id', time: 'x-share-time', signature: 'x-share-signature' } as const;

/**
 * The generator's ids: fixed, so the same ids are on the same side of a share across restarts and Verify can compare
 * windows. 101 of them: enough that a share of a few percent still gets several ids, and a prime that shares no factor
 * with 100, the period of the canary's split, so the ids turn independently of it (traffic.ts).
 */
export const IDS: readonly string[] = Array.from({ length: 101 }, (_, i) => `traffic-${String(i).padStart(3, '0')}`);

/** What a signature is for: an id, the time it was made, and the one request it may be sent with. */
export interface Signed {
  id: string;
  /** Seconds since the Unix epoch, whole. */
  time: number;
  /** The request's `Host`, in lower case, with its port if it names one. */
  host: string;
  method: string;
  /** The request target as sent: the path and its query. */
  path: string;
}

/** The message signed: the context and each field, in this order, as UTF-8, each after its length as 4 bytes, big-endian. */
export function message({ id, time, host, method, path }: Signed): Buffer {
  return Buffer.concat(
    [CONTEXT, id, String(time), host, method, path].flatMap((field) => {
      const bytes = Buffer.from(field, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
}

/** The headers that send an id with a GET of a path, signed now. */
export type Sign = (id: string, path: string) => RequestHeaders;

/** Signs ids for GETs of the app's host with the generator's private key. */
export function signer(key: KeyObject, host: string, now: () => number = Date.now): Sign {
  const lower = host.toLowerCase();
  return (id, path) => {
    const time = Math.floor(now() / 1000);
    const signature = sign(null, message({ id, time, host: lower, method: 'GET', path }), key);
    return { [HEADERS.id]: id, [HEADERS.time]: String(time), [HEADERS.signature]: signature.toString('base64url') };
  };
}

/** The generator's private key, or why there is none: no file (a cluster made before the key), or one it cannot use. */
export type ShareKey = { key: KeyObject } | { none: string };

/** Reads the private key, PEM, from its Secret's file. The reason given never quotes the file. */
export async function readShareKey(path: string): Promise<ShareKey> {
  let pem: string;
  try {
    pem = await readFile(path, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { none: code === 'ENOENT' ? `no key at ${path}` : `cannot read ${path} (${code ?? 'unknown error'})` };
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    return { none: `${path} is not a private key in PEM` };
  }
  if (key.asymmetricKeyType !== 'ed25519') return { none: `${path} is a ${key.asymmetricKeyType} key, not Ed25519` };
  return { key };
}
