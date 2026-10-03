import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { RawEvent } from '@software-factory/events';
import { DiskArtifacts } from '@software-factory/store';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.ts';
import { Feed } from '../src/feed.ts';
import { loadSite } from '../src/site.ts';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** A build as Vite lays one out: the page, a hashed script and its manifest. */
function fakeBuild(): string {
  const dist = mkdtempSync(join(tmpdir(), 'dist-'));
  mkdirSync(join(dist, '.vite'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Software Factory · Martin Rogan</title>');
  writeFileSync(join(dist, 'assets/index-AbC123.js'), `console.log(${JSON.stringify('x'.repeat(2000))});`);
  writeFileSync(
    join(dist, '.vite/manifest.json'),
    JSON.stringify({ 'index.html': { file: 'assets/index-AbC123.js' } }),
  );
  return dist;
}

const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const feed = new Feed();
let screenshot: string;
let server: Server;
let base: string;

const event = (seq: number, extra: Partial<RawEvent> = {}) => ({
  event: {
    id: crypto.randomUUID(),
    seq,
    ts: new Date(Date.UTC(2026, 9, 3, 9, seq)).toISOString(),
    work_item: '1296',
    type: 'work-item.summarised',
    version: 1,
    actor: 'planner',
    summary: `Event ${seq}`,
    payload: { title: 'Prices go negative', description: '…', story: '…' },
    artifacts: [],
    ...extra,
  } as RawEvent & { seq: number },
  appendedAt: Date.now(),
});

beforeAll(async () => {
  screenshot = await artifacts.put(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  feed.add([
    event(1),
    event(2, {
      artifacts: [{ kind: 'file', hash: screenshot, type: 'image/png', size: 4, name: 'a picture' }],
    } as never),
    event(3),
  ]);
  server = createServer(createApp({ commit: COMMIT, site: loadSite(fakeBuild()), feed, artifacts }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Reads an event stream until it has seen `count` events, then hangs up. */
function readStream(path: string, headers: Record<string, string>, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ids: string[] = [];
    const req = request(`${base}${path}`, { headers }, (res) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        for (const [, id] of buffer.matchAll(/^id: (\d+)$/gm)) if (id && !ids.includes(id)) ids.push(id);
        if (ids.length >= count) {
          req.destroy();
          resolve(ids);
        }
      });
    });
    req.on('error', (error) => (ids.length >= count ? resolve(ids) : reject(error)));
    req.end();
  });
}

describe('the console server', () => {
  it('reports its health and the commit it was built from', async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
    expect(await (await fetch(`${base}/version`)).json()).toEqual({ commit: COMMIT });
  });

  it('serves the page uncached, so a deploy shows at once', async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toContain('<title>Software Factory · Martin Rogan</title>');
  });

  it('serves built files by the manifest, cached for a year and compressed', async () => {
    const res = await fetch(`${base}/assets/index-AbC123.js`, { headers: { 'accept-encoding': 'br' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-encoding')).toBe('br');
    expect(await res.text()).toContain('console.log');
    expect((await fetch(`${base}/assets/not-built.js`)).status).toBe(404);
  });

  it('sets a strict content security policy, with scripts and connections to itself only', async () => {
    const policy = (await fetch(`${base}/`)).headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'self';");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).not.toContain('unsafe');
  });

  it('serves the events after a seq, as JSON', async () => {
    const res = await fetch(`${base}/api/events?after=1`);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(((await res.json()) as { seq: number }[]).map((e) => e.seq)).toEqual([2, 3]);
    expect((await fetch(`${base}/api/events?after=-1`)).status).toBe(400);
  });

  it('compresses a large answer', async () => {
    feed.add(Array.from({ length: 20 }, (_, i) => event(10 + i)));
    const res = await new Promise<{ encoding: string | undefined; body: Buffer }>((resolve) =>
      request(`${base}/api/events?after=0`, { headers: { 'accept-encoding': 'gzip' } }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c)).on('end', () =>
          resolve({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }),
        );
      }).end(),
    );
    expect(res.encoding).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.body).toString())).toHaveLength(23);
  });

  it('streams events from the start, then resumes from Last-Event-ID with none repeated', async () => {
    expect(await readStream('/api/events/stream?after=0', {}, 3)).toEqual(['1', '2', '3']);
    const resumed = readStream('/api/events/stream', { 'last-event-id': '29' }, 2);
    feed.add([event(30), event(31)]);
    expect(await resumed).toEqual(['30', '31']);
  });

  it('serves an artifact a public event refers to, with its recorded type, for good', async () => {
    const res = await fetch(`${base}/artifacts/${screenshot}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it('serves nothing it was not asked to publish', async () => {
    const unpublished = await artifacts.put(new TextEncoder().encode('not in any public event'));
    expect((await fetch(`${base}/artifacts/${unpublished}`)).status).toBe(404);
    expect((await fetch(`${base}/artifacts/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it('says where to go when a page is missing', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('The console lives at /.');
  });

  it('refuses methods other than GET and HEAD', async () => {
    const res = await fetch(`${base}/api/events`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });
});
