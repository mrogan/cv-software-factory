/**
 * The files the console serves, read once at startup. A missing file stops the server before it listens.
 *
 * Paths are relative to the repository root, and the image keeps the same layout, so the page uses the design
 * system's files directly rather than copies of them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export interface Asset {
  body: Buffer;
  type: string;
  etag: string;
}

const HTML = 'text/html; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const SVG = 'image/svg+xml';
const WOFF2 = 'font/woff2';

const fromRepo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const fromPackage = createRequire(import.meta.url).resolve;

/** URL path → [file, content type]. */
const FILES: Record<string, [string, string]> = {
  '/': [fromRepo('apps/console/public/index.html'), HTML],
  '/assets/console.css': [fromRepo('apps/console/public/console.css'), CSS],
  '/assets/tokens.css': [fromRepo('docs/design/system/tokens.css'), CSS],
  '/favicon.svg': [fromRepo('docs/design/system/mark/icon.svg'), SVG],
  '/fonts/instrument-serif-400.woff2': [
    fromPackage('@fontsource/instrument-serif/files/instrument-serif-latin-400-normal.woff2'),
    WOFF2,
  ],
  '/fonts/instrument-serif-400-italic.woff2': [
    fromPackage('@fontsource/instrument-serif/files/instrument-serif-latin-400-italic.woff2'),
    WOFF2,
  ],
  '/fonts/geist.woff2': [fromPackage('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'), WOFF2],
  '/fonts/geist-mono.woff2': [
    fromPackage('@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2'),
    WOFF2,
  ],
};

/** Loads every asset, filling the build's commit into the page's footer. */
export function loadAssets(commit: string): Map<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const [path, [file, type]] of Object.entries(FILES)) {
    let body = readFileSync(file);
    if (type === HTML) {
      const html = body
        .toString('utf-8')
        .replaceAll('%COMMIT%', commit)
        .replaceAll('%COMMIT_SHORT%', commit.slice(0, 7));
      body = Buffer.from(html);
    }
    const etag = `"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;
    assets.set(path, { body, type, etag });
  }
  return assets;
}
