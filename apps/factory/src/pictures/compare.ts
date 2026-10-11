/**
 * Two screenshots of the same page compared pixel by pixel: the share of pixels that differ, and a picture of where.
 * The comparison is `pixelmatch`'s, which ignores the anti-aliasing a font renders a little differently from one run
 * to the next, so an unchanged page compares as unchanged.
 *
 * Two pages of different heights (a release that adds a paragraph, say) are compared where they overlap, and what
 * only one of them has counts as changed: the diff is the size of the larger, red where they differ and wherever one
 * has pixels the other does not.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export interface Comparison {
  /** The share of the larger picture's pixels that differ, from 0 to 1. */
  changed: number;
  /** Where they differ, as a PNG: the first picture faded, with the differences in red. Null when none do. */
  diff: Uint8Array | null;
}

/** How far apart two colours may be and still be the same pixel: pixelmatch's own default. */
const THRESHOLD = 0.1;
const RED = [255, 0, 0, 255] as const;

export function compare(a: Uint8Array, b: Uint8Array): Comparison {
  const first = PNG.sync.read(Buffer.from(a));
  const second = PNG.sync.read(Buffer.from(b));
  const width = Math.max(first.width, second.width);
  const height = Math.max(first.height, second.height);
  const overlap = { width: Math.min(first.width, second.width), height: Math.min(first.height, second.height) };
  const output = new PNG({ width: overlap.width, height: overlap.height });
  const differing = pixelmatch(
    crop(first, overlap),
    crop(second, overlap),
    output.data,
    overlap.width,
    overlap.height,
    { threshold: THRESHOLD },
  );
  const outside = width * height - overlap.width * overlap.height;
  const changed = (differing + outside) / (width * height);
  if (changed === 0) return { changed: 0, diff: null };
  const diff = new PNG({ width, height });
  for (let i = 0; i < diff.data.length; i += 4) diff.data.set(RED, i);
  PNG.bitblt(output, diff, 0, 0, overlap.width, overlap.height, 0, 0);
  return { changed, diff: new Uint8Array(PNG.sync.write(diff)) };
}

/** The top left of an image's pixels, the size given, as RGBA. */
function crop(image: PNG, size: { width: number; height: number }): Uint8Array {
  if (image.width === size.width && image.height === size.height) return image.data;
  const out = new Uint8Array(size.width * size.height * 4);
  for (let y = 0; y < size.height; y++) {
    const from = y * image.width * 4;
    out.set(image.data.subarray(from, from + size.width * 4), y * size.width * 4);
  }
  return out;
}
