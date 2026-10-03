/**
 * The crawler against a small site made for the test (crawl-site.ts): once on a site that is right, where nothing
 * is found, and once for each fault, where the crawler finds it on the route and in the class a fair observer would
 * name. A class found on every page is one finding on `*`. These tests need Chromium, so they run in the pinned
 * Playwright image.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateSignal } from '@software-factory/events/schemas';
import { DiskArtifacts } from '@software-factory/store';
import { type Browser, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLASSES, Crawler } from '../../src/crawler/index.ts';
import type { Observation } from '../../src/senses/types.ts';
import { type Fault, startSite } from './crawl-site.ts';

let browser: Browser;
const store = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'crawler-artifacts-')));
const log = { warn: () => {} };

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(() => browser?.close());

async function crawl(...faults: Fault[]): Promise<Observation[]> {
  const site = await startSite(...faults);
  try {
    return await new Crawler({ app: site.url, store, log, launch: async () => browser }).pass('c'.repeat(40));
  } finally {
    await site.close();
  }
}

const found = (observations: Observation[]) => observations.filter((o) => o.finding).map((o) => o.check);

describe('on a site that is right', () => {
  it('finds nothing, and has a check for every class on every route it crawled', async () => {
    const observations = await crawl();
    expect(found(observations)).toEqual([]);
    const checks = observations.map((o) => o.check);
    expect(checks).toContain('missing-header@/items/:item');
    expect(checks).toContain('not-cached@/static/:file');
    expect(checks).toContain('missing-header@*');
  }, 120_000);
});

/** [a fault of the site, the one check that finds it, what the crawler calls it]. */
const CASES: Array<[Fault, string, string]> = [
  ['dead-link', 'broken-link@/', 'broken-link'],
  ['dead-image', 'broken-image@/', 'broken-image'],
  ['not-an-image', 'broken-image@/', 'broken-image'],
  ['loop', 'redirect-loop@/loop', 'redirect-loop'],
  ['error-500', 'server-error@/items/:item', 'server-error'],
  ['console-home', 'browser-error@/', 'browser-error'],
  ['no-alt-about', 'missing-alt@/about', 'missing-alt'],
  ['contrast-about', 'low-contrast@/about', 'low-contrast'],
  ['unlabelled', 'unlabelled-field@/about', 'unlabelled-field'],
  ['no-headers-home', 'missing-header@/', 'missing-header'],
  ['no-cache', 'not-cached@/static/:file', 'not-cached'],
  ['slow-about', 'slow-response@/about', 'slow-response'],
  ['leaky-missing', 'leaks-detail@/:missing', 'leaks-detail'],
  ['leaky-malformed', 'leaks-detail@/:malformed', 'leaks-detail'],
  ['powered-by', 'leaks-detail@/:missing', 'leaks-detail'],
  // A class found on every page crawled is one finding for every route.
  ['console-all', 'browser-error@*', 'browser-error'],
  ['no-alt-all', 'missing-alt@*', 'missing-alt'],
  ['contrast-all', 'low-contrast@*', 'low-contrast'],
  ['no-headers-all', 'missing-header@*', 'missing-header'],
];

describe('a class found on every page', () => {
  it('is one finding for the pages, and still found on the assets that had it too', async () => {
    const observations = await crawl('slow-all');
    expect(found(observations).sort()).toEqual(['slow-response@*', 'slow-response@/static/:file']);
  }, 120_000);
});

describe('what the crawl could not tell', () => {
  /** What was reported as trouble, by check, and whether any check on the route passed. */
  const troubleOn = (observations: Observation[], route: string) =>
    observations.filter((o) => o.route === route && o.trouble);

  it('is trouble, not a pass, when a page that answered will not open in the browser, and the crawl goes on', async () => {
    const observations = await crawl('page-hangs');
    const trouble = troubleOn(observations, '/hangs');
    expect(trouble.map((o) => o.check).sort()).toEqual(
      ['browser-error', 'low-contrast', 'missing-alt', 'missing-header', 'unlabelled-field']
        .map((c) => `${c}@/hangs`)
        .sort(),
    );
    expect(trouble[0]?.trouble).toContain('/hangs');
    expect(found(observations)).toEqual([]);
    // The rest of the site was still looked at.
    expect(observations.map((o) => o.check)).toContain('missing-header@/items/:item');
  }, 60_000);

  it('is trouble, not a pass, when a link gets no answer', async () => {
    const observations = await crawl('no-answer');
    expect(troubleOn(observations, '/reset')).toHaveLength(CLASSES.length);
    expect(troubleOn(observations, '/').map((o) => o.check)).toEqual(['broken-link@/']);
    expect(found(observations)).toEqual([]);
  }, 60_000);
});

describe.each(CASES)('%s', (fault, check, symptom) => {
  it(`is found as ${check}`, async () => {
    const observations = await crawl(fault);
    expect(found(observations)).toEqual([check]);
    const observation = observations.find((o) => o.check === check) as Observation;
    expect(observation.finding?.symptom).toBe(symptom);
    expect(observation.finding?.message).not.toBe('');
    // Its proof: a screenshot with at most four boxes, and a signal the inbox takes.
    const screenshot = observation.artifacts.find((a) => a.kind === 'screenshot');
    expect(screenshot?.kind === 'screenshot' && screenshot.boxes.length <= 4).toBe(true);
    expect(
      validateSignal({
        sense: 'crawler',
        check,
        route: observation.route,
        version: 'c'.repeat(40),
        symptom,
        summary: observation.finding?.message.slice(0, 200),
        evidence: observation.finding?.evidence,
        observedAt: new Date().toISOString(),
        artifacts: observation.artifacts,
      }),
    ).toEqual({ ok: true });
  }, 60_000);
});

describe('what the evidence holds', () => {
  it('has the HTTP exchange for a server error, with the headers looked at', async () => {
    const observations = await crawl('error-500');
    const { evidence } = observations.find((o) => o.check === 'server-error@/items/:item')?.finding ?? {};
    expect(evidence?.[0]).toMatchObject({ kind: 'http', status: 500, url: '/items/b' });
  }, 60_000);

  it('has the elements of an accessibility finding, with their boxes where they are in view', async () => {
    const observations = await crawl('no-alt-all');
    const finding = observations.find((o) => o.check === 'missing-alt@*')?.finding;
    expect(finding?.evidence?.[0]).toMatchObject({ kind: 'accessibility', findings: [{ rule: 'image-alt' }] });
    const screenshot = observations
      .find((o) => o.check === 'missing-alt@*')
      ?.artifacts.find((a) => a.kind === 'screenshot');
    expect(screenshot?.kind === 'screenshot' && screenshot.boxes.length).toBeGreaterThan(0);
  }, 60_000);

  it('has the console messages of a browser error', async () => {
    const observations = await crawl('console-home');
    const finding = observations.find((o) => o.check === 'browser-error@/')?.finding;
    expect(finding?.evidence?.[0]).toMatchObject({ kind: 'console', messages: [{ level: 'error' }] });
  }, 60_000);
});
