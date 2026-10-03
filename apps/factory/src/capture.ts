/**
 * Capturing a page of the app as evidence: a screenshot, and where on it the elements the probe checked are, so
 * the console can mark the problem and the fix. Both go into the artifact store, and the result is the reference
 * an event carries. Milestone 4's probes start here.
 */
import type { Screenshot } from '@software-factory/events';
import type { ArtifactStore } from '@software-factory/store';
import type { Page } from 'playwright';

/** An element the probe looked at: where the problem shows, or the thing as it should be. */
export interface Check {
  selector: string;
  kind: 'problem' | 'fix';
  label?: string;
}

export interface CaptureOptions {
  /** The route as the app names it, such as `/products/:slug`. */
  route: string;
  /** The version the page came from, as its `/version` reported it. */
  version: string;
  checks?: Check[];
}

/**
 * Screenshots what the page shows now, at the size of its viewport. Boxes and the recorded width and height are in
 * CSS pixels; the image itself may be denser, at the page's device scale factor.
 */
export async function capture(page: Page, store: ArtifactStore, options: CaptureOptions): Promise<Screenshot> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('A capture needs a page with a fixed viewport');
  const boxes: Screenshot['boxes'] = [];
  for (const check of options.checks ?? []) {
    const box = await page.locator(check.selector).first().boundingBox();
    if (!box) throw new Error(`Nothing on ${page.url()} matches ${check.selector}`);
    const x = Math.max(0, Math.round(box.x));
    const y = Math.max(0, Math.round(box.y));
    const width = Math.round(Math.min(box.x + box.width, viewport.width) - x);
    const height = Math.round(Math.min(box.y + box.height, viewport.height) - y);
    if (width <= 0 || height <= 0) throw new Error(`${check.selector} is outside the viewport on ${page.url()}`);
    boxes.push({ x, y, width, height, kind: check.kind, ...(check.label && { label: check.label }) });
  }
  const png = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
  return {
    kind: 'screenshot',
    hash: await store.put(png),
    type: 'image/png',
    size: png.byteLength,
    route: options.route,
    version: options.version,
    width: viewport.width,
    height: viewport.height,
    boxes,
  };
}

/**
 * Runs in the browser, where images decode for free: the share of pixels that differ between two images of the
 * same size. A string, because this package is type-checked for Node, not for the DOM.
 */
const DIFFERENCE = `async ([first, second]) => {
  const pixels = async (src) => {
    const image = new Image();
    image.src = src;
    await image.decode();
    const canvas = new OffscreenCanvas(image.naturalWidth, image.naturalHeight);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.naturalWidth, image.naturalHeight).data;
  };
  const [x, y] = await Promise.all([pixels(first), pixels(second)]);
  if (x.length !== y.length) return 1;
  let differ = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) differ++;
  }
  return differ / (x.length / 4);
}`;

/** The share of pixels that differ between two screenshots of the same size. The page can be about:blank. */
export async function pixelDifference(page: Page, a: Uint8Array, b: Uint8Array): Promise<number> {
  const toDataUrl = (png: Uint8Array) => `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  return page.evaluate(`(${DIFFERENCE})(${JSON.stringify([toDataUrl(a), toDataUrl(b)])})`) as Promise<number>;
}
