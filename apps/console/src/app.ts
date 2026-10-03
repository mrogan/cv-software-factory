/**
 * The console's HTTP handler: the page and its built files, the events (as JSON and as a stream), the artifacts,
 * `/health` and `/version`.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';
import type { ArtifactStore } from '@software-factory/store';
import { isHash } from '@software-factory/store';
import type { Feed } from './feed.ts';
import { log } from './log.ts';
import type { File, Site } from './site.ts';
import { resumeFrom, stream } from './stream.ts';

export interface AppOptions {
  /** The commit the running build was made from. */
  commit: string;
  site: Site;
  feed: Feed;
  artifacts: ArtifactStore;
}

/**
 * The page loads its own scripts, styles, fonts and images, talks only to this server, and runs nothing inline.
 * Development relaxes it (vite.config.ts); nothing else does.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Sent with every response. */
const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const YEAR = 'public, max-age=31536000, immutable';

export function createApp({ commit, site, feed, artifacts }: AppOptions): RequestListener {
  const version = JSON.stringify({ commit });

  return (req, res) => {
    const started = performance.now();
    const url = new URL(req.url ?? '/', 'http://console');
    const path = url.pathname;
    res.on('finish', () => {
      if (path === '/health') return;
      const ms = Math.round(performance.now() - started);
      log.info({ method: req.method, path, status: res.statusCode, ms }, `${req.method} ${path} ${res.statusCode}`);
    });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed. The console only reads; nothing here changes the factory.\n');
      return;
    }

    if (path === '/health') return send(req, res, 200, 'application/json', '{"status":"ok"}');
    if (path === '/version') return send(req, res, 200, 'application/json', version);
    if (path === '/' || path === '/index.html') return serve(req, res, site.page, 'no-cache');
    if (path === '/api/events') return events(req, res, feed, url);
    if (path === '/api/events/stream') return stream(feed, req, res, resumeFrom(req, url));
    if (path.startsWith('/artifacts/'))
      return void artifact(req, res, feed, artifacts, path.slice('/artifacts/'.length));

    const file = site.files.get(path);
    if (file) return serve(req, res, file, YEAR);
    send(req, res, 404, 'text/plain; charset=utf-8', 'Not found. The console lives at /.\n');
  };
}

/** The public events after `?after=`, as a JSON array, compressed when the browser accepts it. */
function events(req: IncomingMessage, res: ServerResponse, feed: Feed, url: URL): void {
  const after = Number(url.searchParams.get('after') ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) {
    send(req, res, 400, 'text/plain; charset=utf-8', '`after` is the seq of the last event you have.\n');
    return;
  }
  const json = feed.after(after).map((event) => event.json);
  const body = Buffer.from(`[${json.join(',')}]`);
  res.setHeader('cache-control', 'no-store');
  if (!accepts(req, 'gzip') || body.length < 1024) {
    send(req, res, 200, 'application/json', body);
    return;
  }
  gzip(body, (error, zipped) => {
    if (!error) {
      res.setHeader('content-encoding', 'gzip');
      res.setHeader('vary', 'accept-encoding');
    }
    send(req, res, 200, 'application/json', error ? body : zipped);
  });
}

/** An artifact a public event refers to, with the type recorded when it was stored. Nothing else is served. */
async function artifact(req: IncomingMessage, res: ServerResponse, feed: Feed, store: ArtifactStore, hash: string) {
  const type = isHash(hash) ? feed.artifactType(hash) : undefined;
  const [size, body] = type ? await Promise.all([store.size(hash), store.open(hash)]) : [null, null];
  if (!type || size === null || !body) {
    return send(req, res, 404, 'text/plain; charset=utf-8', 'No such artifact.\n');
  }
  res.writeHead(200, {
    'content-type': type.startsWith('text/') ? `${type}; charset=utf-8` : type,
    'content-length': size,
    'cache-control': YEAR,
    // Opened on its own, an artifact is inert: no script, no styles, no requests.
    'content-security-policy': "default-src 'none'; sandbox",
  });
  if (req.method === 'HEAD') {
    body.destroy();
    res.end();
    return;
  }
  body.pipe(res);
}

function serve(req: IncomingMessage, res: ServerResponse, file: File, cacheControl: string): void {
  res.setHeader('cache-control', cacheControl);
  if (file.br || file.gzip) res.setHeader('vary', 'accept-encoding');
  const [encoding, body] =
    file.br && accepts(req, 'br')
      ? ['br', file.br]
      : file.gzip && accepts(req, 'gzip')
        ? ['gzip', file.gzip]
        : [undefined, file.body];
  if (encoding) res.setHeader('content-encoding', encoding);
  send(req, res, 200, file.type, body);
}

const accepts = (req: IncomingMessage, encoding: string) =>
  String(req.headers['accept-encoding'] ?? '')
    .split(',')
    .some((part) => part.trim().split(';')[0] === encoding);

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
