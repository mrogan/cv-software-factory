/**
 * The canary bird, live: it sits on the Canary panel as the page opens on a release in flight, without a flight, and
 * flies only for events that arrive while the page is open. The samples' server sends no new events, so a stand-in
 * stream does, as the server's would, after the samples it has read.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import type { RawEvent } from '@software-factory/events';
import { expect, test, WIDTHS } from './support.ts';

const SAMPLES = readFileSync(
  fileURLToPath(new URL('../../../packages/samples/log/events.ndjson', import.meta.url)),
  'utf-8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as RawEvent);
const LAST = SAMPLES.at(-1)?.seq ?? 0;
/** v0.9.13's start, on #1314: in flight at the samples' end. */
const STARTED = SAMPLES.findLast((e) => e.type === 'release.started') as RawEvent & {
  payload: { release: string; version: string; previous: string; commit: string };
};

/** An event as the stream would send it, after the samples. */
function event(n: number, type: string, version: number, payload: object): RawEvent {
  return {
    id: `bird-${n}`,
    seq: LAST + n,
    ts: new Date().toISOString(),
    work_item: '1314',
    type,
    version,
    actor: 'rollouts',
    summary: type,
    payload,
    artifacts: [],
  } as unknown as RawEvent;
}

const { release, version, previous, commit } = STARTED.payload;
const promoted = event(1, 'release.promoted', 2, { release, version, previous, commit, watched: true, dryRun: false });
const next = (dryRun: boolean) =>
  event(2, 'release.started', 3, {
    ...STARTED.payload,
    release: 'bird000001-914',
    version: 'v0.9.14',
    previous: version,
    dryRun,
  });

/**
 * The page with a stream that says the store holds samples and then sends what the test gives it, and a count of the
 * bird's flights: each time it takes the `flying` class.
 */
async function open(page: Page, query = 'theme=paper'): Promise<void> {
  await page.addInitScript(() => {
    const scope = globalThis as unknown as { sfFlights: number; sfStream: unknown; EventSource: unknown };
    scope.sfFlights = 0;
    // A batch of changes to the bird's classes that ends with it flying, from a state that was not, is a flight.
    new MutationObserver((records) => {
      const mine = records.filter((record) => (record.target as Element).classList?.contains('bird-fly'));
      const [first] = mine;
      if (!first) return;
      const flying = (first.target as Element).classList.contains('flying');
      if (flying && !first.oldValue?.split(' ').includes('flying')) scope.sfFlights += 1;
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['class'], attributeOldValue: true });
    class Stream extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor() {
        super();
        scope.sfStream = this;
        setTimeout(() => {
          this.onopen?.(new Event('open'));
          this.dispatchEvent(new MessageEvent('store', { data: JSON.stringify({ kind: 'sample' }) }));
        }, 0);
      }
      close() {
        this.readyState = 2;
      }
    }
    scope.EventSource = Stream;
  });
  await page.goto(`/?${query}`);
  await page.locator('section.canary').waitFor();
}

const send = (page: Page, ...raws: RawEvent[]) =>
  page.evaluate((raws) => {
    const stream = (globalThis as unknown as { sfStream: { onmessage: (event: MessageEvent) => void } }).sfStream;
    for (const raw of raws) stream.onmessage(new MessageEvent('message', { data: JSON.stringify(raw) }));
  }, raws);

const flights = (page: Page) => page.evaluate(() => (globalThis as unknown as { sfFlights: number }).sfFlights);

const bird = (page: Page) => page.locator('.bird-fly');
const cage = (page: Page) => page.locator('.stations sf-station[kind="release"]');

/** The bird stands on the panel's top edge: its box crosses it. */
async function onThePanel(page: Page, flyer: Locator): Promise<void> {
  await expect(async () => {
    const [box, card] = await Promise.all([flyer.boundingBox(), page.locator('section.canary').boundingBox()]);
    expect(box && card && box.y < card.y && box.y + box.height > card.y).toBe(true);
  }).toPass();
}

test.describe('the canary bird', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('sits on the Canary panel as the page opens on a release in flight, and does not fly', async ({ page }) => {
    await open(page);
    await expect(bird(page)).toBeVisible();
    await expect(cage(page)).toHaveAttribute('bird', 'out');
    await onThePanel(page, bird(page));
    // Long enough for a flight from the cage to have begun.
    await page.waitForTimeout(800);
    expect(await flights(page)).toBe(0);
    await expect(page.locator('.bird-layer')).toHaveAttribute('aria-hidden', 'true');
  });

  test('flies home at a promotion that arrives live, and out to the panel for the next release', async ({ page }) => {
    await open(page);
    await expect(bird(page)).toBeVisible();
    await send(page, promoted);
    // A trill, then home: the cage has its bird again.
    await expect(bird(page)).toBeHidden({ timeout: 10_000 });
    await expect(cage(page)).not.toHaveAttribute('bird', 'out');
    expect(await flights(page)).toBe(1);
    await send(page, next(false));
    await expect(bird(page)).toBeVisible();
    await expect(cage(page)).toHaveAttribute('bird', 'out');
    await expect.poll(() => flights(page)).toBe(2);
    await expect(bird(page)).not.toHaveClass(/flying/, { timeout: 10_000 });
    await onThePanel(page, bird(page));
    await expect(bird(page)).not.toHaveClass(/paper/);
  });

  test('is a paper bird for a dry run', async ({ page }) => {
    await open(page);
    await send(page, promoted, next(true));
    await expect(bird(page)).toHaveClass(/paper/, { timeout: 10_000 });
  });

  test('takes no notice of a copy of an event the page held as it opened', async ({ page }) => {
    await open(page);
    await expect(bird(page)).toBeVisible();
    // v0.9.13's start again, as the line records it on another work item it carries.
    await send(page, { ...STARTED, id: 'bird-copy', seq: LAST + 1, work_item: '1315' } as RawEvent);
    await page.waitForTimeout(800);
    expect(await flights(page)).toBe(0);
  });

  test('never flies with motion off: it is simply home, and simply on the panel', async ({ page }) => {
    await open(page, 'theme=paper&motion=off');
    await expect(bird(page)).toBeVisible();
    await send(page, promoted);
    await expect(bird(page)).toBeHidden({ timeout: 10_000 });
    await send(page, next(false));
    await expect(bird(page)).toBeVisible();
    await onThePanel(page, bird(page));
    expect(await flights(page)).toBe(0);
  });

  test('never flies on a phone, where the panel is a screen away from the station', async ({ page }) => {
    await page.setViewportSize(WIDTHS.phone);
    await open(page);
    await send(page, promoted);
    await expect(bird(page)).toBeHidden({ timeout: 10_000 });
    await send(page, next(false));
    await expect(bird(page)).toBeVisible();
    await onThePanel(page, bird(page));
    expect(await flights(page)).toBe(0);
  });
});
