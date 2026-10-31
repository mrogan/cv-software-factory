import type { ArtifactStore } from '@software-factory/store';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { capture, capturePage, screenshot } from '../src/capture.ts';

/** Playwright's words for the error Chromium gave when it could not capture a frame. */
const UNABLE =
  'page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot\nCall log:\n  - taking page screenshot\n';
const PNG = new Uint8Array([137, 80, 78, 71]);

/** A page that is only as much of one as a capture uses, whose screenshots fail with these errors first. */
function fakePage(...failures: Error[]) {
  const page = {
    calls: 0,
    viewport: { width: 800, height: 600 },
    viewportSize: () => page.viewport,
    sizes: [] as Array<{ width: number; height: number }>,
    setViewportSize: async (size: { width: number; height: number }) => {
      page.sizes.push(size);
      page.viewport = size;
    },
    // The page is taller than the viewport, so a capture of the whole of it resizes the viewport first.
    evaluate: async () => 1200,
    screenshot: async () => {
      const failure = failures[page.calls++];
      if (failure) throw failure;
      return PNG;
    },
  };
  return page;
}
const store = { put: async () => 'f'.repeat(64) } as unknown as ArtifactStore;
const options = { route: '/products/:slug', version: 'a'.repeat(40) };

describe('a screenshot', () => {
  it('is taken again when Chromium could not capture the frame, and the second one kept', async () => {
    const page = fakePage(new Error(UNABLE));
    expect(await screenshot(page as unknown as Page, { type: 'png' }, async () => {})).toBe(PNG);
    expect(page.calls).toBe(2);
  });

  it('is taken once only on any other error, which is thrown as it came', async () => {
    const page = fakePage(new Error('page.screenshot: Target page, context or browser has been closed'));
    await expect(screenshot(page as unknown as Page, { type: 'png' }, async () => {})).rejects.toThrow(
      'has been closed',
    );
    expect(page.calls).toBe(1);
  });

  it('is taken twice at most, and Chromium failing both times is thrown', async () => {
    const page = fakePage(new Error(UNABLE), new Error(UNABLE));
    await expect(screenshot(page as unknown as Page, { type: 'png' }, async () => {})).rejects.toThrow(
      'Unable to capture',
    );
    expect(page.calls).toBe(2);
  });
});

describe('a capture', () => {
  it('of the viewport survives one frame Chromium could not capture', async () => {
    const page = fakePage(new Error(UNABLE));
    const shot = await capture(page as unknown as Page, store, options);
    expect(shot.size).toBe(PNG.byteLength);
    expect(page.calls).toBe(2);
  });

  it('of the whole page survives one too, and puts the viewport back after', async () => {
    const page = fakePage(new Error(UNABLE));
    const { png } = await capturePage(page as unknown as Page, store, { ...options, maxHeight: 1600 });
    expect(png).toBe(PNG);
    expect(page.calls).toBe(2);
    expect(page.viewport).toEqual({ width: 800, height: 600 });
    expect(page.sizes).toEqual([
      { width: 800, height: 1200 },
      { width: 800, height: 600 },
    ]);
  });
});
