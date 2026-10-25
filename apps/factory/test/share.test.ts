import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RequestHeaders } from '../src/senses/http.ts';
import { CONTEXT, HEADERS, IDS, message, readShareKey, type Signed, signer } from '../src/traffic/share.ts';

/** The contract's test vector, as docs/COMPONENTS/FEATURE-FLAGS.md writes it down for the app. */
interface Vector {
  privateKey: string;
  publicKey: string;
  request: Signed;
  message: string;
  headers: Record<string, string>;
}
async function vector(): Promise<Vector> {
  const doc = await readFile(new URL('../../../docs/COMPONENTS/FEATURE-FLAGS.md', import.meta.url), 'utf-8');
  const block = doc.split('### Test vector')[1]?.match(/```json\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error('FEATURE-FLAGS.md has no test vector');
  return JSON.parse(block) as Vector;
}

/**
 * The app's side of the contract, as the doc says it: a request is signed when its three headers are there, its time
 * is less than a minute old and not from the future, and the signature verifies over the request as the app sees it.
 * The app writes its own; this one shows that the message binds what the doc says it does.
 */
function accepts(key: KeyObject, headers: RequestHeaders, request: Omit<Signed, 'id' | 'time'>, now: number): boolean {
  const id = headers[HEADERS.id];
  const time = headers[HEADERS.time];
  const signature = headers[HEADERS.signature];
  if (id === undefined || time === undefined || signature === undefined || !/^(0|[1-9][0-9]*)$/.test(time)) {
    return false;
  }
  const age = now - Number(time);
  if (age < 0 || age >= 60) return false;
  const signed = message({ ...request, id, time: Number(time), host: request.host.toLowerCase() });
  return verify(null, signed, key, Buffer.from(signature, 'base64url'));
}

const request = { host: 'website.localhost', method: 'GET', path: '/search?q=glove' };
const at = 1_793_001_600;

describe('the signed message', () => {
  it('is the vector’s, byte for byte, and so is its signature', async () => {
    const v = await vector();
    expect(message(v.request).toString('hex')).toBe(v.message);
    const key = createPrivateKey(v.privateKey);
    expect(createPublicKey(key).export({ type: 'spki', format: 'pem' }) as string).toBe(v.publicKey);
    // RFC 8032's first test key, whose public key the RFC gives.
    expect(createPublicKey(v.publicKey).export({ format: 'jwk' }).x).toBe(
      Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url'),
    );
    // Any moment in the second signs the same: the time is whole seconds.
    const sign = signer(key, v.request.host, () => v.request.time * 1000 + 999);
    expect(sign(v.request.id, v.request.path)).toEqual(v.headers);
    expect(v.headers[HEADERS.signature]).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(accepts(createPublicKey(v.publicKey), v.headers, v.request, v.request.time)).toBe(true);
  });

  it('begins with the context, and keeps each field apart by its length', () => {
    const one = message({ id: 'ab', time: 1, ...request });
    expect(one.subarray(0, 4).readUInt32BE()).toBe(Buffer.byteLength(CONTEXT));
    expect(one.subarray(4, 4 + Buffer.byteLength(CONTEXT)).toString()).toBe(CONTEXT);
    // The same bytes in all, split differently between two fields, are another message.
    const shifted = message({ id: 'ab', time: 1, ...request, host: 'website.localhost/search', path: '?q=glove' });
    expect(shifted.equals(message({ id: 'ab', time: 1, ...request }))).toBe(false);
    expect(message({ id: 'a', time: 1, ...request, host: `b${request.host}` }).equals(one)).toBe(false);
  });

  it('is for the one request it was made for, by its key, within the minute after it was made', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const headers = signer(privateKey, 'Website.Localhost', () => at * 1000)('traffic-007', request.path);
    expect(accepts(publicKey, headers, request, at)).toBe(true);
    expect(accepts(publicKey, headers, request, at + 59)).toBe(true);
    expect(accepts(publicKey, headers, request, at + 60)).toBe(false);
    expect(accepts(publicKey, headers, request, at - 1)).toBe(false);
    expect(accepts(publicKey, headers, { ...request, path: '/search?q=duster' }, at)).toBe(false);
    expect(accepts(publicKey, headers, { ...request, path: '/search' }, at)).toBe(false);
    expect(accepts(publicKey, headers, { ...request, host: 'console.localhost' }, at)).toBe(false);
    expect(accepts(publicKey, headers, { ...request, method: 'HEAD' }, at)).toBe(false);
    expect(accepts(publicKey, { ...headers, [HEADERS.id]: 'traffic-008' }, request, at)).toBe(false);
    expect(accepts(publicKey, { ...headers, [HEADERS.time]: String(at + 1) }, request, at + 1)).toBe(false);
    const { [HEADERS.signature]: _, ...unsigned } = headers;
    expect(accepts(publicKey, unsigned, request, at)).toBe(false);
    expect(accepts(generateKeyPairSync('ed25519').publicKey, headers, request, at)).toBe(false);
  });
});

describe('the ids', () => {
  it('are 101 fixed names, a prime count sharing no factor with the canary’s period of 100', () => {
    expect(IDS).toHaveLength(101);
    expect(new Set(IDS).size).toBe(101);
    expect(IDS[0]).toBe('traffic-000');
    expect(IDS[100]).toBe('traffic-100');
    for (let factor = 2; factor * factor <= IDS.length; factor++) expect(IDS.length % factor).not.toBe(0);
  });
});

describe('the generator’s key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'share-key-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('is an Ed25519 private key, read from its file', async () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const read = await readShareKey(file('good', pem));
    expect('key' in read && read.key.asymmetricKeyType).toBe('ed25519');
  });

  it('is none, with the reason, when there is no file, or one that is not such a key, and never quotes it', async () => {
    expect(await readShareKey(join(dir, 'absent'))).toEqual({ none: `no key at ${join(dir, 'absent')}` });
    const garbled = await readShareKey(file('garbled', 'secret-looking garbage'));
    expect(garbled).toEqual({ none: expect.stringContaining('is not a private key in PEM') });
    expect(JSON.stringify(garbled)).not.toContain('garbage');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    }) as string;
    expect(await readShareKey(file('rsa', rsa))).toEqual({ none: expect.stringContaining('rsa key, not Ed25519') });
    const pub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;
    expect(await readShareKey(file('public', pub))).toEqual({ none: expect.stringContaining('not a private key') });
  });
});
