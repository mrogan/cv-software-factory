// Writes an SVG that blinks between two PNGs, half a second each, under a band that says which is showing:
// node blink.ts <before.png> <after.png> <out.svg>
// The PNGs are embedded, so the SVG stands alone when GitHub shows it in a description.
import { readFileSync, writeFileSync } from 'node:fs';

const [before, after, out] = process.argv.slice(2);
if (!before || !after || !out) {
  console.error('usage: node blink.ts <before.png> <after.png> <out.svg>');
  process.exit(2);
}

const png = (path: string) => {
  const bytes = readFileSync(path);
  if (bytes.toString('latin1', 1, 4) !== 'PNG') throw new Error(`${path} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), data: bytes.toString('base64') };
};

const [b, a] = [png(before), png(after)];
const width = Math.max(b.width, a.width);
const band = 32;
const height = band + Math.max(b.height, a.height);

// Each frame covers the whole picture, so a smaller After hides all of Before.
const frame = (label: string, image: ReturnType<typeof png>) => `
  <rect width="${width}" height="${height}" fill="#fff"/>
  <rect width="${width}" height="${band}" fill="#1f2328"/>
  <text x="12" y="${band / 2}" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" font-weight="600" fill="#fff">${label}</text>
  <image y="${band}" width="${image.width}" height="${image.height}" href="data:image/png;base64,${image.data}"/>`;

writeFileSync(
  out,
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<g>${frame('Before', b)}
</g>
<g opacity="0">${frame('After', a)}
  <animate attributeName="opacity" values="0;1" keyTimes="0;0.5" calcMode="discrete" dur="1s" repeatCount="indefinite"/>
</g>
</svg>
`,
);
