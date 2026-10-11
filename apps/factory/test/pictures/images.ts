/** Pictures made for the tests. */
import { PNG } from 'pngjs';

/** A PNG of one colour, with a rectangle of another where asked. */
export function png(
  width: number,
  height: number,
  patch?: { x: number; y: number; width: number; height: number; rgb: [number, number, number] },
): Uint8Array {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inPatch = patch && x >= patch.x && x < patch.x + patch.width && y >= patch.y && y < patch.y + patch.height;
      const [r, g, b] = inPatch ? patch.rgb : [255, 255, 255];
      image.data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return new Uint8Array(PNG.sync.write(image));
}
