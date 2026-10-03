/**
 * Each probe against a small shop made for the test (shop.ts): once on a shop that is right, where it passes, and
 * once on a shop with the one fault it looks for, where it fails with the symptom a fair observer would name. The
 * probes are proved this way, without the app they look after. These tests need Chromium, so they run in the
 * pinned Playwright image (`make e2e`, and CI's browser job).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSignal } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBES } from '../../src/probes/index.ts';
import { Shop } from '../../src/probes/site.ts';
import { BrowserSense } from '../../src/senses/browser.ts';
import type { Observation } from '../../src/senses/types.ts';
import { type Fault, startShop } from './shop.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'probe-artifacts-')));
const log = { warn: () => {} };

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

/** Runs the probes whose names are given (all of them if none are) against a shop with these faults. */
async function observe(faults: Fault[], only: string[] = []): Promise<Observation[]> {
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
    // The proof it keeps: a screenshot, with at most four boxes, and and the sentence that says what was expected and seen goes in the signal's summary.
    const screenshot = found?.artifacts.find((a) => a.kind === 'screenshot');
    expect(screenshot?.kind === 'screenshot' && screenshot.boxes.length <= 4).toBe(true);
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
