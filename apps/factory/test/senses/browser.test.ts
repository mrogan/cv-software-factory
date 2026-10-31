import type { Browser, Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { BrowserSense } from '../../src/senses/browser.ts';

/** A browser that is only as much of one as the sense uses, and that can be killed. */
function fakeBrowser() {
  const browser = {
    connected: true,
    closed: false,
    isConnected: () => browser.connected,
    close: async () => {
      browser.closed = true;
    },
    newContext: async () => ({
      newPage: async () => ({ setDefaultTimeout: () => {} }) as unknown as Page,
      close: async () => {},
    }),
  };
  return browser;
}

function senseWith(launch: () => Promise<Browser>) {
  return new BrowserSense({
    name: 'probe',
    app: 'http://shop.test',
    checks: [],
    store: {} as never,
    shared: () => ({}),
    log: { warn: () => {} },
    launch,
  });
}

describe('the browser a sense uses', () => {
  it('is launched once, however many ask for it at the same time', async () => {
    const launched: Array<ReturnType<typeof fakeBrowser>> = [];
    const sense = senseWith(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const browser = fakeBrowser();
      launched.push(browser);
      return browser as unknown as Browser;
    });
    await Promise.all([sense.withPage(async () => {}), sense.pass('a'.repeat(40)), sense.withPage(async () => {})]);
    expect(launched).toHaveLength(1);
  });

  it('is launched again when it has died', async () => {
    const launched: Array<ReturnType<typeof fakeBrowser>> = [];
    const sense = senseWith(async () => {
      const browser = fakeBrowser();
      launched.push(browser);
      return browser as unknown as Browser;
    });
    await sense.withPage(async () => {});
    (launched[0] as ReturnType<typeof fakeBrowser>).connected = false;
    await sense.withPage(async () => {});
    await sense.pass('a'.repeat(40));
    expect(launched).toHaveLength(2);
  });

  it('is launched again after a launch that failed', async () => {
    let attempts = 0;
    const sense = senseWith(async () => {
      if (++attempts === 1) throw new Error('no Chromium');
      return fakeBrowser() as unknown as Browser;
    });
    await expect(sense.withPage(async () => {})).rejects.toThrow('no Chromium');
    await sense.withPage(async () => {});
    expect(attempts).toBe(2);
  });

  it('is closed with the sense', async () => {
    const browser = fakeBrowser();
    const sense = senseWith(async () => browser as unknown as Browser);
    await sense.withPage(async () => {});
    await sense.close();
    expect(browser.closed).toBe(true);
  });
});

/**
 * A page that answers what a finding's proof asks of it, and whose screenshot fails as many times as it is told, with
 * an error that is not tried again (capture.test.ts has the one that is).
 */
function pageWith(failures: number) {
  const page = {
    screenshots: 0,
    setDefaultTimeout: () => {},
    on: () => {},
    off: () => {},
    url: () => 'http://shop.test/',
    viewportSize: () => ({ width: 1280, height: 800 }),
    close: async () => {},
    // An element the check boxed that is not on the page.
    locator: () => ({ first: () => ({ scrollIntoViewIfNeeded: async () => {}, boundingBox: async () => null }) }),
    screenshot: async () => {
      if (page.screenshots++ < failures) throw new Error('page.screenshot: Target crashed');
      return new Uint8Array([1]);
    },
  };
  return page;
}

async function proofOf(page: ReturnType<typeof pageWith>, look: Array<{ selector: string; kind: 'problem' }>) {
  const warnings: string[] = [];
  const sense = new BrowserSense({
    name: 'probe',
    app: 'http://shop.test',
    checks: [
      {
        id: 'home',
        route: '/',
        run: async () => ({ symptom: 'server-error', message: 'The home page answered 500.', evidence: [], look }),
      },
    ],
    store: { put: async () => 'f'.repeat(64) } as never,
    shared: () => ({}),
    log: { warn: (_fields, message) => warnings.push(message) },
    launch: async () =>
      ({
        isConnected: () => true,
        newContext: async () => ({ newPage: async () => page, close: async () => {} }),
      }) as unknown as Browser,
  });
  const [observation] = await sense.pass('a'.repeat(40));
  return { observation, warnings };
}

describe("a finding's screenshot", () => {
  it('is taken once, when the finding asked for no boxes, and a failure says there is none', async () => {
    const page = pageWith(1);
    const { observation, warnings } = await proofOf(page, []);
    expect(observation?.finding?.symptom).toBe('server-error');
    expect(observation?.artifacts).toEqual([]);
    expect(page.screenshots).toBe(1);
    expect(warnings).toEqual(['no screenshot of a finding']);
  });

  it('is taken again without its boxes when they do not fit', async () => {
    const page = pageWith(0);
    const { observation, warnings } = await proofOf(page, [{ selector: 'main', kind: 'problem' }]);
    expect(observation?.artifacts).toMatchObject([{ kind: 'screenshot', boxes: [] }]);
    expect(page.screenshots).toBe(1);
    expect(warnings).toEqual(['the boxes did not fit the screenshot; taking it without']);
  });
});
