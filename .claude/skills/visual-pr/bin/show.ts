// Writes an SVG that shows how a picture changed, as fits the change:
// node show.ts <before.png> <after.png> <out.svg>
// A change in a few small places blinks, Before over After, 0.8s each, long enough to read a line, under a band that
// says which is showing, so the change is what moves; a reader who asks for reduced motion sees After, still. A change
// over much of the picture, such as a list reordered, is too much to follow in a blink: it is shown two-up, Before
// beside After (above it when the pictures are wider than tall), each under its band, with what changed outlined on
// both.
// It prints which it chose, and whether a two-up is outlined, for the caption. The PNGs are embedded, so the SVG
// stands alone when GitHub shows it in a description.
//
// What changed is found as the factory finds it (`apps/factory/src/pictures/compare.ts`): pixelmatch at its default
// threshold, which ignores anti-aliasing, over where the pictures overlap; what only one of them has counts as changed.
// The outlines are drawn as the console marks an element on a screenshot (`.mk` in its `pictures.css`): dashed, in
// the design system's `attn`.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

const [before, after, out] = process.argv.slice(2);
if (!before || !after || !out) {
  console.error('usage: node show.ts <before.png> <after.png> <out.svg>');
  process.exit(2);
}

/** How far apart two colours may be and still be the same pixel: pixelmatch's own default, as the factory's. */
const THRESHOLD = 0.1;
/** The side of the squares a picture is cut into to say where it changed. */
const CELL = 16;
/**
 * The share of squares that may change and still blink. Small changes (a word, an icon, a rule) change at most a
 * twentieth of them; a list reordered or a strip redrawn, more than two fifths.
 */
const MOST_TO_BLINK = 0.25;
/** Rows of pixels apart that outlined rows are one box: a line of text with its leading. */
const LINE = 24;
/** Columns at each side of a picture never outlined: where a snapshot of one element draws its border's corners. */
const EDGE = 8;
/** The share of a picture its outlines may cover and still tell the reader where to look. */
const MOST_OUTLINED = 0.5;
/** The design system's `attn` (`docs/design/system/tokens.css`), which the console's marks are drawn in. */
const ATTN = '#b53c0a';
const BAND = 32;
const GAP = 16;

type Picture = { image: PNG; data: string };

const png = (path: string): Picture => {
  try {
    const bytes = readFileSync(path);
    return { image: PNG.sync.read(bytes), data: bytes.toString('base64') };
  } catch {
    console.error(`${path} is not a PNG`);
    process.exit(1);
  }
};

const [b, a] = [png(before), png(after)];
const width = Math.max(b.image.width, a.image.width);
const height = Math.max(b.image.height, a.image.height);

/** The squares that changed, row by row: those where any pixel differs, or that only one picture reaches. */
function changedCells() {
  const overlap = {
    width: Math.min(b.image.width, a.image.width),
    height: Math.min(b.image.height, a.image.height),
  };
  const mask = new Uint8Array(overlap.width * overlap.height * 4);
  pixelmatch(crop(b.image, overlap), crop(a.image, overlap), mask, overlap.width, overlap.height, {
    threshold: THRESHOLD,
    diffMask: true,
  });
  const columns = Math.ceil(width / CELL);
  const rows = Math.ceil(height / CELL);
  const cells = new Uint8Array(columns * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const outside = x >= overlap.width || y >= overlap.height;
      if (outside || mask[(y * overlap.width + x) * 4 + 3]) {
        cells[Math.floor(y / CELL) * columns + Math.floor(x / CELL)] = 1;
      }
    }
  }
  return { cells, columns, rows };
}

/** The top left of an image's pixels, the size given, as RGBA. */
function crop(image: PNG, size: { width: number; height: number }): Uint8Array {
  if (image.width === size.width && image.height === size.height) return image.data;
  const cropped = new Uint8Array(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    const from = y * image.width * 4;
    cropped.set(image.data.subarray(from, from + size.width * 4), y * size.width * 4);
  }
  return cropped;
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * What changed on each side, as boxes, found as a patience diff finds changed lines: each row of pixels is a line.
 * Rows found once in each picture are matched where their order agrees, and each match grows up and down while the
 * rows beside it are the same, so a block that moved is matched whole, its blank rows too. A block that moved down
 * because something was put above it is not outlined, and what was put above it is, on After; what moved away is
 * outlined on Before. A row of background alone is never outlined, and outlined rows closer than a line of text are
 * one box. Rows are compared as wide as both pictures are, so a picture that grew wider still matches, unless a row
 * has something drawn in the columns only the wider one has: that row matches none, and is outlined. Content whose
 * rows all repeat, such as stripes, has nothing found once to match by, and is all outlined or, past half of it, not.
 */
function places(): { before: Box[]; after: Box[] } {
  const shared = Math.min(b.image.width, a.image.width);
  const rows = (picture: Picture, side: string) =>
    Array.from({ length: picture.image.height }, (_, y) => {
      const { width: w, data } = picture.image;
      const pixel = (x: number) => data.readUInt32BE((y * w + x) * 4);
      const background = w > shared ? commonest(w, pixel) : 0;
      for (let x = shared; x < w; x++) if (pixel(x) !== background) return `${side} ${y}`;
      return createHash('sha1')
        .update(data.subarray(y * w * 4, (y * w + shared) * 4))
        .digest('base64');
    });
  const [was, is] = [rows(b, 'before'), rows(a, 'after')];
  const counts = (lines: string[]) => {
    const count = new Map<string, number>();
    for (const line of lines) count.set(line, (count.get(line) ?? 0) + 1);
    return count;
  };
  const [inWas, inIs] = [counts(was), counts(is)];
  const where = new Map(is.map((line, j) => [line, j]));
  // Rows found once in each: their places in Before, and in After.
  const [uniqueWas, uniqueIs] = [[] as number[], [] as number[]];
  was.forEach((line, i) => {
    const j = where.get(line);
    if (j !== undefined && inWas.get(line) === 1 && inIs.get(line) === 1) [uniqueWas.push(i), uniqueIs.push(j)];
  });
  // The longest run of those whose order agrees in both: the longest increasing subsequence of their places in After,
  // by patience sorting. ends[n] is the run of n + 1 that ends lowest; previous[k] is the one before k in its run.
  const ends: number[] = [];
  const previous = new Int32Array(uniqueIs.length).fill(-1);
  uniqueIs.forEach((j, k) => {
    let [low, high] = [0, ends.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((uniqueIs.at(ends.at(middle) ?? 0) ?? 0) < j) low = middle + 1;
      else high = middle;
    }
    previous[k] = low > 0 ? (ends.at(low - 1) ?? -1) : -1;
    ends[low] = k;
  });
  const [stayedBefore, stayedAfter] = [new Uint8Array(was.length), new Uint8Array(is.length)];
  const match = (i: number, j: number) => {
    stayedBefore[i] = 1;
    stayedAfter[j] = 1;
  };
  const anchors: [number, number][] = [];
  for (let k = ends.at(-1) ?? -1; k >= 0; k = previous.at(k) ?? -1) {
    anchors.unshift([uniqueWas.at(k) ?? 0, uniqueIs.at(k) ?? 0]);
  }
  for (const [i, j] of anchors) match(i, j);
  for (const [i, j] of anchors) {
    for (
      let d = 1;
      i - d >= 0 && j - d >= 0 && !stayedBefore[i - d] && !stayedAfter[j - d] && was[i - d] === is[j - d];
      d++
    ) {
      match(i - d, j - d);
    }
    for (
      let d = 1;
      i + d < was.length &&
      j + d < is.length &&
      !stayedBefore[i + d] &&
      !stayedAfter[j + d] &&
      was[i + d] === is[j + d];
      d++
    ) {
      match(i + d, j + d);
    }
  }
  return { before: boxes(b, stayedBefore), after: boxes(a, stayedAfter) };
}

/** The most common of a picture's pixels along a row or down a column, as packed RGBA: its background. */
function commonest(count: number, pixel: (n: number) => number): number {
  const counts = new Map<number, number>();
  for (let n = 0; n < count; n++) counts.set(pixel(n), (counts.get(pixel(n)) ?? 0) + 1);
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
}

/** The rows of a picture that did not stay, as boxes around what is drawn on them. */
function boxes(picture: Picture, stayed: Uint8Array): Box[] {
  const { width: w, height: h, data } = picture.image;
  const pixel = (x: number, y: number) => data.readUInt32BE((y * w + x) * 4);
  // A pixel is drawn when it is neither its row's background nor its column's, so a panel's edge, which runs down
  // the picture, is not drawn on every row it crosses; nor are its rounded corners, at the picture's own edges.
  const columns = Array.from({ length: w }, (_, x) => commonest(h, (y) => pixel(x, y)));
  const drawn = (y: number) => {
    const background = commonest(w, (x) => pixel(x, y));
    let [left, right] = [w, -1];
    for (let x = EDGE; x < w - EDGE; x++) {
      const at = pixel(x, y);
      if (at !== background && at !== columns[x]) [left, right] = [Math.min(left, x), x];
    }
    return right < 0 ? null : { left, right };
  };
  const found: Box[] = [];
  let open: { top: number; bottom: number; left: number; right: number } | null = null;
  for (let y = 0; y < stayed.length; y++) {
    const on = stayed[y] ? null : drawn(y);
    if (on && open && y - open.bottom <= LINE) {
      open = { top: open.top, bottom: y, left: Math.min(open.left, on.left), right: Math.max(open.right, on.right) };
    } else if (on) {
      if (open) found.push(box(open));
      open = { top: y, bottom: y, left: on.left, right: on.right };
    }
  }
  if (open) found.push(box(open));
  return found;
}

const box = ({ top, bottom, left, right }: { top: number; bottom: number; left: number; right: number }): Box => ({
  x: left,
  y: top,
  width: right - left + 1,
  height: bottom - top + 1,
});

const band = (label: string, w: number) => `
  <rect width="${w}" height="${BAND}" fill="#1f2328"/>
  <text x="12" y="${BAND / 2}" dominant-baseline="central" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="15" font-weight="600" fill="#fff">${label}</text>`;
const image = (picture: Picture) =>
  `<image y="${BAND}" width="${picture.image.width}" height="${picture.image.height}" href="data:image/png;base64,${picture.data}"/>`;

function blink() {
  // Each frame covers the whole picture, so a smaller one hides all of the other.
  const frame = (label: string, picture: Picture) => `
  <rect width="${width}" height="${BAND + height}" fill="#fff"/>${band(label, width)}
  ${image(picture)}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${BAND + height}" viewBox="0 0 ${width} ${BAND + height}">
<style>@media (prefers-reduced-motion: reduce) { .before { display: none; } }</style>
<g>${frame('After', a)}
</g>
<g class="before">${frame('Before', b)}
  <animate attributeName="opacity" values="1;0" keyTimes="0;0.5" calcMode="discrete" dur="1.6s" repeatCount="indefinite"/>
</g>
</svg>
`;
}

function twoUp({ before: was, after: is }: ReturnType<typeof places>) {
  const beside = width <= height;
  const [total, tall] = beside ? [width * 2 + GAP, BAND + height] : [width, (BAND + height) * 2 + GAP];
  // Outlines that cover most of a picture say only that it all changed, which the two-up already shows.
  const area = (boxes: Box[]) => boxes.reduce((sum, { width: w, height: h }) => sum + w * h, 0);
  const telling =
    area(was) <= MOST_OUTLINED * b.image.width * b.image.height &&
    area(is) <= MOST_OUTLINED * a.image.width * a.image.height;
  // Each side outlines its own boxes, just outside what they hold, as the console's marks sit, and within its picture.
  const side = (label: string, picture: Picture, boxes: Box[], x: number, y: number) => {
    const outlines = (telling ? boxes : []).map((box) => {
      const [left, top] = [Math.max(1, box.x - 3), Math.max(1, box.y - 3)];
      const right = Math.min(picture.image.width - 1, box.x + box.width + 3);
      const bottom = Math.min(picture.image.height - 1, box.y + box.height + 3);
      return `<rect x="${left}" y="${BAND + top}" width="${right - left}" height="${bottom - top}" rx="3" fill="none" stroke="${ATTN}" stroke-width="1.5" stroke-opacity="0.7" stroke-dasharray="4 3"/>`;
    });
    return `
<g transform="translate(${x} ${y})">${band(label, width)}
  ${image(picture)}
  ${outlines.join('\n  ')}
</g>`;
  };
  const [ax, ay] = beside ? [width + GAP, 0] : [0, BAND + height + GAP];
  const outlined = telling && was.length + is.length > 0;
  return {
    outlined,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${tall}" viewBox="0 0 ${total} ${tall}">
<rect width="${total}" height="${tall}" fill="#fff"/>${side('Before', b, was, 0, 0)}${side('After', a, is, ax, ay)}
</svg>
`,
  };
}

const changed = changedCells();
const share = changed.cells.reduce((sum, cell) => sum + cell, 0) / changed.cells.length;
const percent = `${Math.round(share * 100)}% of the picture changed`;
mkdirSync(dirname(out), { recursive: true });
if (share <= MOST_TO_BLINK) {
  writeFileSync(out, blink());
  console.log(`blink: ${percent}`);
} else {
  const { svg, outlined } = twoUp(places());
  writeFileSync(out, svg);
  console.log(`two-up, ${outlined ? 'outlined' : 'not outlined'}: ${percent}`);
}
