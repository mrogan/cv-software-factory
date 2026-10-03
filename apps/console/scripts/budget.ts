/**
 * Fails if the built browser code outgrows its budget (budget.json): gzipped JavaScript and CSS, everything the
 * build makes, whether the first view loads it or not. `make check` runs it after the build.
 */
import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DIST } from '../src/site.ts';

const budget = JSON.parse(readFileSync(new URL('../budget.json', import.meta.url), 'utf-8')) as Record<string, number>;
const manifest = JSON.parse(readFileSync(join(DIST, '.vite/manifest.json'), 'utf-8')) as Record<
  string,
  { file: string; css?: string[] }
>;
const files = new Set(Object.values(manifest).flatMap((chunk) => [chunk.file, ...(chunk.css ?? [])]));
const totals = { javascript: 0, css: 0 };
for (const file of files) {
  const size = gzipSync(readFileSync(join(DIST, file)), { level: 9 }).length;
  if (extname(file) === '.js') totals.javascript += size;
  if (extname(file) === '.css') totals.css += size;
}
let over = false;
for (const [kind, size] of Object.entries(totals)) {
  const limit = budget[kind] ?? 0;
  const line = `${kind.padEnd(10)} ${(size / 1000).toFixed(1).padStart(6)} kB of ${(limit / 1000).toFixed(1)} kB, gzipped`;
  if (size > limit) {
    over = true;
    console.error(`${line}: over budget`);
  } else console.log(line);
}
if (over) process.exit(1);
