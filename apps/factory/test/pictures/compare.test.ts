import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { compare } from '../../src/pictures/compare.ts';
import { png } from './images.ts';

const pixel = (bytes: Uint8Array, x: number, y: number) => {
  const image = PNG.sync.read(Buffer.from(bytes));
  return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
};

describe('comparing two pictures of a page', () => {
  it('finds nothing changed in the same picture, and draws no diff', () => {
    expect(compare(png(40, 30), png(40, 30))).toEqual({ changed: 0, diff: null });
  });

  it('says what share of the pixels changed, and draws them in red', () => {
    const { changed, diff } = compare(png(40, 30), png(40, 30, { x: 0, y: 0, width: 10, height: 6, rgb: [0, 0, 0] }));
    expect(changed).toBe(60 / 1200);
    if (!diff) throw new Error('Expected a diff');
    const image = PNG.sync.read(Buffer.from(diff));
    expect([image.width, image.height]).toEqual([40, 30]);
    expect(pixel(diff, 2, 2)).toEqual([255, 0, 0, 255]);
    // An unchanged pixel is the first picture's, faded.
    expect(pixel(diff, 30, 20).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('ignores a colour too close to tell apart', () => {
    expect(compare(png(40, 30), png(40, 30, { x: 0, y: 0, width: 10, height: 6, rgb: [254, 254, 254] })).changed).toBe(
      0,
    );
  });

  it('compares pages of different sizes where they overlap, and counts the rest as changed', () => {
    const { changed, diff } = compare(png(40, 30), png(40, 50));
    expect(changed).toBe((40 * 20) / (40 * 50));
    if (!diff) throw new Error('Expected a diff');
    const image = PNG.sync.read(Buffer.from(diff));
    expect([image.width, image.height]).toEqual([40, 50]);
    expect(pixel(diff, 5, 40)).toEqual([255, 0, 0, 255]);
    expect(pixel(diff, 5, 10).slice(0, 3)).toEqual([255, 255, 255]);
    // Either way round.
    expect(compare(png(40, 50), png(40, 30)).changed).toBe(0.4);
    expect(compare(png(30, 30), png(40, 20)).changed).toBe(1 - 600 / 1200);
  });
});
