/**
 * The admin service's settings, the client address its rate limits key on, the limits, and its codes: what needs no
 * store and no browser.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { clientAddress, RateLimit } from '../../src/admin/client.ts';
import { configFromEnv, proxies } from '../../src/admin/config.ts';
import { codeHash, newCode, normalCode, sha256 } from '../../src/admin/secrets.ts';

const request = (peer: string, forwardedFor?: string) =>
  ({
    socket: { remoteAddress: peer },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  }) as unknown as IncomingMessage;

describe('the client’s address', () => {
  const traefik = proxies('10.42.0.0/16');

  it('is the connection’s when it does not come from the proxy, whatever it forwards', () => {
    expect(clientAddress(request('203.0.113.9', '198.51.100.1'), traefik)).toBe('203.0.113.9');
    expect(clientAddress(request('::ffff:203.0.113.9', '198.51.100.1'), traefik)).toBe('203.0.113.9');
    expect(clientAddress(request('10.42.0.7', '198.51.100.1'), proxies(''))).toBe('10.42.0.7');
  });

  it('is the address the proxy saw, never one the client wrote to its left', () => {
    expect(clientAddress(request('10.42.0.7', '198.51.100.1'), traefik)).toBe('198.51.100.1');
    expect(clientAddress(request('10.42.0.7', '192.0.2.66, 198.51.100.1'), traefik)).toBe('198.51.100.1');
    expect(clientAddress(request('10.42.0.7', '198.51.100.1, 10.42.0.9'), traefik)).toBe('198.51.100.1');
    // Nothing forwarded, or nothing an address: the proxy's own, so every such request shares one limit.
    expect(clientAddress(request('10.42.0.7'), traefik)).toBe('10.42.0.7');
    expect(clientAddress(request('10.42.0.7', 'nonsense'), traefik)).toBe('10.42.0.7');
  });
});

describe('a rate limit', () => {
  it('allows so many from an address in a window, then says how long to wait', () => {
    let now = 0;
    const limit = new RateLimit({ requests: 2, minutes: 1 }, () => now);
    expect(limit.take('a')).toEqual({ ok: true });
    expect(limit.take('a')).toEqual({ ok: true });
    expect(limit.take('b')).toEqual({ ok: true });
    now = 15_000;
    expect(limit.take('a')).toEqual({ ok: false, retryAfter: 45 });
    now = 60_000;
    expect(limit.take('a')).toEqual({ ok: true });
  });

  it('forgets an address once its window has ended and another starts', () => {
    let now = 0;
    const limit = new RateLimit({ requests: 1, minutes: 1 }, () => now);
    expect(limit.take('a')).toEqual({ ok: true });
    now = 30_000;
    expect(limit.take('b')).toEqual({ ok: true });
    now = 60_000;
    expect(limit.take('c')).toEqual({ ok: true });
    expect(limit.remembered()).toEqual(['b', 'c']);
  });
});

describe('the settings', () => {
  it('take the console’s origin exactly, and the relying party from it', () => {
    expect(configFromEnv({ ADMIN_ORIGIN: 'https://console.localhost:8443' })).toMatchObject({
      origin: 'https://console.localhost:8443',
      rpId: 'console.localhost',
      port: 8080,
    });
    for (const origin of ['https://console.localhost:8443/', 'http://console.example', 'console.localhost', '']) {
      expect(() => configFromEnv({ ADMIN_ORIGIN: origin }), origin).toThrow();
    }
    expect(() => configFromEnv({ ADMIN_ORIGIN: 'https://console.localhost', ADMIN_RP_ID: 'example.com' })).toThrow();
    expect(() => configFromEnv({ ADMIN_ORIGIN: 'https://a.b', ADMIN_TRUSTED_PROXIES: 'traefik' })).toThrow();
    expect(() => configFromEnv({ ADMIN_ORIGIN: 'https://a.b', ADMIN_TRUSTED_PROXIES: '10.0.0.0/33' })).toThrow();
  });
});

describe('an enrolment code', () => {
  it('is 128 random bits, read back however it is typed', () => {
    const codes = new Set(Array.from({ length: 100 }, newCode));
    expect(codes.size).toBe(100);
    for (const code of codes) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
      // The first character holds the highest three of 128 bits: 130 would need it higher.
      expect('01234567').toContain(code[0]);
      expect(codeHash(code.toLowerCase().replaceAll('-', ' '))).toBe(sha256(code.replaceAll('-', '')));
    }
    expect(normalCode('0O1IL')).toBeUndefined();
    expect(normalCode('oooooo-11111-iiiii-lllll-00000')).toBe(`000000${'1'.repeat(15)}00000`);
  });
});
