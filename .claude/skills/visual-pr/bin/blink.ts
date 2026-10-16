// Writes an SVG that blinks between two PNGs, half a second each, under a band that says which is showing:
// node blink.ts <before.png> <after.png> <out.svg>
// The PNGs are embedded, so the SVG stands alone when GitHub shows it in a description. Before blinks over After, so
// a reader who asks for reduced motion sees After, still.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const [before, after, out] = process.argv.slice(2);
if (!before || !after || !out) {
  console.error('usage: node blink.ts <before.png> <after.png> <out.svg>');
  process.exit(2);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A PNG's first chunk is its header, IHDR, which starts with the width and height.
const png = (path: string) => {
  const bytes = readFileSync(path);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(SIGNATURE) || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    console.error(`${path} is not a PNG`);
    process.exit(1);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), data: bytes.toString('base64') };
};

const [b, a] = [png(before), png(after)];
const width = Math.max(b.width, a.width);
const band = 32;
const height = band + Math.max(b.height, a.height);

// Each frame covers the whole picture, so a smaller one hides all of the other.
const frame = (label: string, image: ReturnType<typeof png>) => `
  <rect width="${width}" height="${height}" fill="#fff"/>
  <rect width="${width}" height="${band}" fill="#1f2328"/>
  <text x="12" y="${band / 2}" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" font-weight="600" fill="#fff">${label}</text>
  <image y="${band}" width="${image.width}" height="${image.height}" href="data:image/png;base64,${image.data}"/>`;

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<style>@media (prefers-reduced-motion: reduce) { .before { display: none; } }</style>
<g>${frame('After', a)}
</g>
<g class="before">${frame('Before', b)}
  <animate attributeName="opacity" values="1;0" keyTimes="0;0.5" calcMode="discrete" dur="1s" repeatCount="indefinite"/>
</g>
</svg>
`,
);
