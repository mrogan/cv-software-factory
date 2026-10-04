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
