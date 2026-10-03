import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import type { RawEvent } from '@software-factory/events';
import { type ArtifactStore, DiskArtifacts } from '@software-factory/store';
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

  it('compresses a large answer, with brotli where the browser takes it', async () => {
    feed.add(Array.from({ length: 20 }, (_, i) => event(10 + i)));
    const fetchRaw = (accept: string) =>
      new Promise<{ encoding: string | undefined; body: Buffer }>((resolve) =>
        request(`${base}/api/events?after=0`, { headers: { 'accept-encoding': accept } }, (r) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c)).on('end', () =>
            resolve({ encoding: r.headers['content-encoding'], body: Buffer.concat(chunks) }),
          );
        }).end(),
      );
    const br = await fetchRaw('gzip, deflate, br');
    expect(br.encoding).toBe('br');
    expect(JSON.parse(brotliDecompressSync(br.body).toString())).toHaveLength(23);
    const gzip = await fetchRaw('gzip');
    expect(gzip.encoding).toBe('gzip');
    expect(JSON.parse(gunzipSync(gzip.body).toString())).toHaveLength(23);
  });

  it('streams events from the start, then resumes from Last-Event-ID with none repeated', async () => {
    expect(await readStream('/api/events/stream?after=0', {}, 3)).toEqual(['1', '2', '3']);
    const resumed = readStream('/api/events/stream', { 'last-event-id': '29' }, 2);
    feed.add([event(30), event(31)]);
    expect(await resumed).toEqual(['30', '31']);
  });

  it('tells an open stream when an empty store learns what it holds', async () => {
    feed.kind = null;
    const messages = await new Promise<string[]>((resolve, reject) => {
      const req = request(`${base}/api/events/stream?after=0`, (res) => {
        let buffer = '';
        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          const stores = buffer.split('\n\n').filter((part) => part.startsWith('event: store'));
          // \`make real-store\` marks the store while the console is open: the stream says so again.
          if (stores.length === 1 && feed.kind === null) feed.kind = 'real';
          if (stores.length === 2) {
            req.destroy();
            resolve(stores);
          }
        });
      });
      req.on('error', reject);
      req.end();
    });
    expect(messages).toEqual(['event: store\ndata: {"kind":null}', 'event: store\ndata: {"kind":"real"}']);
  });

  it('says first on every stream what the store holds, as a message that is not an event', async () => {
    const first = (kind: Feed['kind']) =>
      new Promise<string>((resolve, reject) => {
        feed.kind = kind;
        const req = request(`${base}/api/events/stream?after=0`, (res) => {
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const message = buffer.split('\n\n').find((part) => part.startsWith('event:'));
            if (message) {
              req.destroy();
              resolve(message);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    expect(await first('real')).toBe('event: store\ndata: {"kind":"real"}');
    expect(await first(null)).toBe('event: store\ndata: {"kind":null}');
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

describe('an artifact that goes wrong partway', () => {
  /** A console whose store hands out `body` for any artifact, as if it were a large file. */
  async function consoleWith(body: Readable): Promise<{ url: string; close: () => Promise<void> }> {
    const store: ArtifactStore = {
      put: () => Promise.reject(new Error('read-only')),
      size: async () => 1_000_000,
      open: async () => body,
    };
    const app = createServer(createApp({ commit: COMMIT, site: loadSite(fakeBuild()), feed, artifacts: store }));
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
    return {
      url,
      close: () => {
        app.closeAllConnections();
        return new Promise<void>((resolve) => app.close(() => resolve()));
      },
    };
  }

  it('closes the file when the browser stops loading it', async () => {
    const body = new Readable({ read() {} });
    body.push(Buffer.alloc(1024));
    const { url, close } = await consoleWith(body);
    await new Promise<void>((resolve) => {
      const req = request(`${url}/artifacts/${screenshot}`, (res) => res.once('data', () => req.destroy()));
      req.on('error', () => {}).on('close', () => resolve());
      req.end();
    });
    await expect.poll(() => body.destroyed).toBe(true);
    await close();
  });

  it('ends the response, not the console, when a read fails', async () => {
    const body = new Readable({
      read() {
        this.destroy(Object.assign(new Error('i/o error'), { code: 'EIO' }));
      },
    });
    const { url, close } = await consoleWith(body);
    const cut = await new Promise<boolean>((resolve) => {
      request(`${url}/artifacts/${screenshot}`, (res) => {
        res
          .on('data', () => {})
          .on('error', () => resolve(true))
          .on('end', () => resolve(false));
      })
        .on('error', () => resolve(true))
        .end();
    });
    expect(cut).toBe(true);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await close();
  });
});
