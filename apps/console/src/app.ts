/**
 * The console's HTTP handler: the page and its assets, `/health` and `/version`.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { Asset } from './assets.ts';
import { log } from './log.ts';

export interface AppOptions {
  /** The commit the running build was made from. */
  commit: string;
  assets: Map<string, Asset>;
}

/** Sent with every response. The page loads nothing but its own files, and runs no script. */
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'none'; style-src 'self'; font-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function createApp({ commit, assets }: AppOptions): RequestListener {
  const version = JSON.stringify({ commit });

  return (req, res) => {
    const started = performance.now();
    const path = new URL(req.url ?? '/', 'http://console').pathname;
    res.on('finish', () => {
      if (path === '/health') return;
      const ms = Math.round(performance.now() - started);
      log.info({ method: req.method, path, status: res.statusCode, ms }, `${req.method} ${path} ${res.statusCode}`);
    });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed. The console only serves pages for now.\n');
      return;
    }

    if (path === '/health') return send(req, res, 200, 'application/json', '{"status":"ok"}');
    if (path === '/version') return send(req, res, 200, 'application/json', version);

    const asset = assets.get(path);
    if (!asset) return send(req, res, 404, 'text/plain; charset=utf-8', 'Not found. The console lives at /.\n');

    res.setHeader('etag', asset.etag);
    res.setHeader('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304).end();
      return;
    }
    send(req, res, 200, asset.type, asset.body);
  };
}

function send(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(req.method === 'HEAD' ? undefined : body);
}
