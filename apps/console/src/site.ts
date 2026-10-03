/**
 * The built page and its files, read once at startup from Vite's output (`dist/`, made by `vite build`). A file
 * the manifest lists but the build lacks stops the server before it listens.
 *
 * Text files are compressed once, here, with Brotli and gzip, so each request only picks the encoding.
 */
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg']);

export interface File {
  type: string;
  body: Buffer;
  br?: Buffer;
  gzip?: Buffer;
}

export interface Site {
  /** The page, at `/`. Never cached, so a deploy shows at once. */
  page: File;
  /** Every other built file, by its path. Each name carries a hash of its contents, so it is cached for a year. */
  files: Map<string, File>;
}

interface ManifestChunk {
  file: string;
  css?: string[];
  assets?: string[];
}

export function loadSite(dist = DIST): Site {
  if (!existsSync(join(dist, '.vite/manifest.json')) && process.env.NODE_ENV !== 'production') {
    // In development Vite serves the page; this server only answers for events and artifacts.
    const page = {
      type: 'text/plain; charset=utf-8',
      body: Buffer.from('In development, Vite serves the page on :8080.\n'),
    };
    return { page, files: new Map() };
  }
  const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf-8')) as Record<
    string,
    ManifestChunk
  >;
  const paths = new Set(
    Object.values(manifest).flatMap((chunk) => [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]),
  );
  const files = new Map([...paths].map((path) => [`/${path}`, read(join(dist, path))]));
  return { page: read(join(dist, 'index.html')), files };
}

function read(file: string): File {
  const extension = extname(file);
  const type = TYPES[extension];
  if (!type) throw new Error(`The build made ${file}, a kind of file the console does not serve`);
  const body = readFileSync(file);
  if (!COMPRESSIBLE.has(extension)) return { type, body };
  return {
    type,
    body,
    br: brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    gzip: gzipSync(body, { level: 9 }),
  };
}
