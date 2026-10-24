/**
 * Each probe against a small shop made for the test (shop.ts): once on a shop that is right, where it passes, and
 * once on a shop with the one fault it looks for, where it fails with the symptom a fair observer would name. The
 * probes are proved this way, without the app they look after. These tests need Chromium, so they run in the
 * pinned Playwright image (`make e2e`, and CI's browser job).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Screenshot } from '@software-factory/events';
import { validateSignal } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PROBES } from '../../src/probes/index.ts';
import { Shop } from '../../src/probes/site.ts';
import { BrowserSense } from '../../src/senses/browser.ts';
import { observeApp } from '../../src/senses/observe.ts';
import type { Observation } from '../../src/senses/types.ts';
import { type Fault, startShop } from './shop.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'probe-artifacts-')));
/** What the sense warned of in this test, such as a screenshot it could not take, for a failure to say. */
const warnings: string[] = [];
const log = { warn: (fields: object, message: string) => warnings.push(`${message} ${JSON.stringify(fields)}`) };

beforeAll(async () => {
  browser = await chromium.launch();
});
beforeEach(() => {
  warnings.length = 0;
});
afterAll(() => browser?.close());

/**
 * Runs the probes whose names are given (all of them if none are) against a shop with these faults, saying what each
 * left on the device when asked to.
 */
async function observe(faults: Fault[], only: string[] = [], device = false): Promise<Observation[]> {
  const shop = await startShop(...faults);
  try {
    const checks = PROBES.filter((check) => !only.length || only.includes(check.id));
    const sense = new BrowserSense({
      name: 'probe',
      app: shop.url,
      checks,
      store,
      log,
      shared: () => new Shop(shop.url),
      launch: async () => browser,
      device,
    });
    return await sense.pass('a'.repeat(40));
  } finally {
    await shop.close();
  }
}

const failing = (observations: Observation[]) =>
  observations.filter((o) => o.finding).map((o) => `${o.check} ${o.finding?.symptom}`);

describe('on a shop that is right', () => {
  it('passes every probe, and the checks on whatever else the pages did', async () => {
    const observations = await observe([]);
    expect(observations.filter((o) => o.trouble).map((o) => `${o.check}: ${o.trouble}`)).toEqual([]);
    expect(failing(observations)).toEqual([]);
    // One result for each probe, and the three the watch adds to it.
    expect(observations).toHaveLength(PROBES.length * 4);
  }, 120_000);
});

/** [the probe, a fault of the shop, what the probe calls it]. */
const CASES: Array<[string, Fault, string]> = [
  ['home-leads-to-the-catalogue', 'catalogue-404', 'broken-link'],
  ['home-leads-to-the-catalogue', 'catalogue-500', 'server-error'],
  ['home-leads-to-the-catalogue', 'catalogue-empty', 'wrong-result'],
  ['home-links-open', 'link-404', 'broken-link'],
  ['home-links-open', 'link-loop', 'redirect-loop'],
  ['departments-list-their-products', 'department-wrong', 'wrong-result'],
  ['catalogue-agrees-with-the-api', 'catalogue-price', 'wrong-result'],
  ['catalogue-agrees-with-the-api', 'catalogue-name', 'wrong-result'],
  ['catalogue-pages-cover-the-range', 'catalogue-gap', 'wrong-result'],
  ['catalogue-pages-cover-the-range', 'catalogue-repeat', 'wrong-result'],
  ['catalogue-filters-by-department', 'filter-leak', 'wrong-result'],
  ['catalogue-pages-cover-the-range', 'next-page-500', 'server-error'],
  ['catalogue-filters-by-department', 'next-page-500', 'server-error'],
  ['departments-list-their-products', 'next-page-500', 'server-error'],
  ['product-page-agrees-with-the-api', 'product-price', 'wrong-result'],
  ['product-page-agrees-with-the-api', 'product-heading', 'wrong-result'],
  ['product-page-agrees-with-the-api', 'product-404', 'broken-link'],
  ['product-page-agrees-with-the-api', 'product-500', 'server-error'],
  ['search-finds-a-product-by-a-word-in-its-name', 'search-misses', 'wrong-result'],
  ['search-ignores-case', 'search-case', 'wrong-result'],
  ['search-for-nothing-finds-nothing', 'search-everything', 'wrong-result'],
  ['search-takes-any-typed-text', 'search-500', 'server-error'],
  ['search-takes-any-typed-text', 'search-400', 'rejects-valid-input'],
  ['contact-accepts-a-message', 'contact-refuses', 'rejects-valid-input'],
  ['contact-accepts-a-message', 'contact-500', 'server-error'],
  ['contact-accepts-awkward-but-valid-input', 'contact-422', 'rejects-valid-input'],
  // What any page can do wrong, found whichever probe opened it.
  ['home-leads-to-the-catalogue/console', 'console-error', 'browser-error'],
  ['product-page-agrees-with-the-api/server-error', 'product-500', 'server-error'],
  ['product-page-agrees-with-the-api/broken-image', 'broken-image', 'broken-image'],
];

describe.each(CASES)('%s', (check, fault, symptom) => {
  it(`calls ${fault} a ${symptom}`, async () => {
    const [id] = check.split('/') as [string];
    const observations = await observe([fault], [id]);
    const found = observations.find((o) => o.check === check);
    expect(found?.trouble).toBeUndefined();
    expect(found?.finding?.symptom).toBe(symptom);
    expect(found?.finding?.message).not.toBe('');
    // The proof it keeps: a screenshot, with at most four boxes, and the sentence that says what was expected and
    // seen goes in the signal's summary. A screenshot the sense could not take is a warning, not an error, so a
    // missing one is told apart from too many boxes, with what the sense warned of.
    const screenshot = found?.artifacts.find((a): a is Screenshot => a.kind === 'screenshot');
    expect(
      screenshot,
      `no screenshot of the finding; the sense warned: ${warnings.join(' | ') || 'nothing'}`,
    ).toBeDefined();
    expect(screenshot?.boxes.length, 'boxes on the screenshot').toBeLessThanOrEqual(4);
    // And the signal the runner would send is one the inbox takes.
    expect(
      validateSignal({
        sense: 'probe',
        check,
        route: found?.route,
        version: 'a'.repeat(40),
        symptom,
        summary: found?.finding?.message.slice(0, 200),
        evidence: found?.finding?.evidence,
        observedAt: new Date().toISOString(),
        artifacts: found?.artifacts,
      }),
    ).toEqual({ ok: true });
  }, 60_000);

  it('passes on the shop without it', async () => {
    const [id] = check.split('/') as [string];
    const observations = await observe([], [id]);
    expect(observations.find((o) => o.check === check)?.finding).toBeNull();
  }, 60_000);
});

describe('a link from the home page that loops', () => {
  it('is filed under the route that loops, as the crawler names it, not the home page', async () => {
    // The home page links one featured item; its siblings are linked only from the about page.
    const observations = await observe(['featured-loop'], ['home-links-open']);
    const found = observations.find((o) => o.check === 'home-links-open');
    expect(found?.finding?.symptom).toBe('redirect-loop');
    expect(found?.route).toBe('/featured/:featured');
  }, 60_000);
});

describe('a shop that writes a price with text against it', () => {
  it('are read for the amount alone', async () => {
    const observations = await observe(
      ['price-run-on'],
      ['catalogue-agrees-with-the-api', 'product-page-agrees-with-the-api'],
    );
    expect(observations.filter((o) => o.trouble).map((o) => `${o.check}: ${o.trouble}`)).toEqual([]);
    expect(failing(observations)).toEqual([]);
  }, 60_000);
});

describe('the contact probes', () => {
  it('take a thank-you that shows the form again, with the word "required" on it, as the message sent', async () => {
    const observations = await observe(
      ['contact-thanks-with-form'],
      ['contact-accepts-a-message', 'contact-accepts-awkward-but-valid-input'],
    );
    expect(observations.filter((o) => o.trouble).map((o) => `${o.check}: ${o.trouble}`)).toEqual([]);
    expect(failing(observations)).toEqual([]);
  }, 60_000);

  it('send messages that say they are the factory’s, and that the shop receives', async () => {
    const shop = await startShop();
    try {
      const sense = new BrowserSense({
        name: 'probe',
        app: shop.url,
        checks: PROBES.filter((check) => check.id.startsWith('contact-')),
        store,
        log,
        shared: () => new Shop(shop.url),
        launch: async () => browser,
      });
      await sense.pass('a'.repeat(40));
      expect(shop.messages).toHaveLength(2);
      for (const message of shop.messages) expect(message.message).toContain('automatic check by the Software Factory');
    } finally {
      await shop.close();
    }
  }, 60_000);
});

describe('what the pages leave on the device, for the gates', () => {
  /** Each check that left something or asked another origin, with what it was, the shop's own origin as `<shop>`. */
  const devices = (observations: Observation[]) =>
    observations
      .filter((o) => o.device && (o.device.kept.length || o.device.asked.length))
      .map((o) => `${o.check}: ${[...(o.device?.kept ?? []), ...(o.device?.asked ?? [])].join(', ')}`)
      .map((line) => line.replace(/http:\/\/127\.0\.0\.1:\d+/g, '<shop>'));

  it('is nothing on a shop that is right, and is not asked of the senses that watch the live app', async () => {
    const observations = await observe([], [], true);
    const own = observations.filter((o) => PROBES.some((p) => p.id === o.check));
    expect(own.every((o) => o.device !== undefined)).toBe(true);
    expect(devices(observations)).toEqual([]);
    // The watch's own checks carry nothing of it.
    expect(observations.filter((o) => o.check.includes('/') && o.device)).toEqual([]);
    expect((await observe([], ['home-leads-to-the-catalogue'])).some((o) => o.device)).toBe(false);
  }, 120_000);

  it('names the first check whose pages kept a cookie or stored anything, and the origins they asked', async () => {
    const observations = await observe(['keeps-cookie', 'keeps-storage', 'asks-elsewhere'], [], true);
    expect(devices(observations)).toEqual([
      'home-leads-to-the-catalogue: cookie visit, http://elsewhere.invalid',
      // Each check that opens the home page asks there again; the cookie is the first's alone.
      'home-links-open: http://elsewhere.invalid',
      'departments-list-their-products: http://elsewhere.invalid',
      'product-page-agrees-with-the-api: localStorage seen on <shop>, sessionStorage viewed on <shop>',
    ]);
  }, 120_000);

  it('fails the probe’s `/device` check when the gates observe the shop, and passes it on a shop that is right', async () => {
    for (const [faults, failed] of [
      [[], []],
      [['keeps-cookie'], ['home-leads-to-the-catalogue/device']],
    ] as const) {
      const shop = await startShop(...faults);
      try {
        const { seen } = await observeApp(shop.url, [{ sense: 'probe', check: 'home-leads-to-the-catalogue' }], {
          store,
          log,
          limit: 10,
        });
        const device = seen.filter((s) => s.check.endsWith('/device'));
        expect(device.map((s) => s.check)).toEqual(['home-leads-to-the-catalogue/device']);
        expect(device.filter((s) => s.failed).map((s) => s.check)).toEqual(failed);
        if (failed.length) expect(device[0]?.message).toBe('The pages left cookie visit on the device.');
      } finally {
        await shop.close();
      }
    }
  }, 120_000);
});
