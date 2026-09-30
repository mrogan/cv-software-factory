import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { loadAssets } from '../src/assets.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(createApp({ commit: COMMIT, assets: loadAssets(COMMIT) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('console', () => {
  it('reports its health', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('reports the commit it was built from', async () => {
    const res = await fetch(`${base}/version`);
    expect(await res.json()).toEqual({ commit: COMMIT });
  });

  it('serves the page with its title and build', async () => {
    const res = await fetch(`${base}/`);
    const html = await res.text();
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(html).toContain('<title>Software Factory · Martin Rogan</title>');
    expect(html).toContain(`/commit/${COMMIT}">build 0123456`);
  });

  it('makes no third-party requests', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const css = await (await fetch(`${base}/assets/console.css`)).text();
    // Links to the source are fine; anything the browser would fetch must be our own.
    const fetched = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .filter(([tag]) => !tag.startsWith('href="https://github.com/'))
      .map(([, url]) => url);
    const fromCss = [...css.matchAll(/url\('([^']+)'\)/g)].map(([, url]) => url);
    for (const url of [...fetched, ...fromCss]) expect(url).toMatch(/^\//);
  });

  it('serves every asset the page and its styles refer to', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const css = await (await fetch(`${base}/assets/console.css`)).text();
    const urls = [
      ...[...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(([, url]) => url),
      ...[...css.matchAll(/url\('(\/[^']+)'\)/g)].map(([, url]) => url),
    ];
    expect(urls.length).toBeGreaterThan(5);
    for (const url of urls) expect((await fetch(`${base}${url}`)).status, url).toBe(200);
  });

  it('sets a strict content security policy', async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers a conditional request with 304', async () => {
    const first = await fetch(`${base}/assets/tokens.css`);
    const etag = first.headers.get('etag') ?? '';
    const again = await fetch(`${base}/assets/tokens.css`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
  });

  it('says where to go when a page is missing', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('The console lives at /.');
  });

  it('refuses methods other than GET and HEAD', async () => {
    const res = await fetch(`${base}/`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});
