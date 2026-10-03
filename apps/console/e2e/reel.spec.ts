import type { Page } from '@playwright/test';
import { consoleUrl, expect, ready, test } from './support.ts';

const renders = (page: Page) =>
  page.evaluate(() => (globalThis as { sfRenders?: { reel: number } }).sfRenders?.reel ?? -1);
const centre = (page: Page) => page.locator('.card[data-place="centre"] h3').textContent();

/** Drags the reel a card and a half to the right, in a given number of pointer moves. */
async function drag(page: Page, frames: number) {
  await page.locator('.reel').scrollIntoViewIfNeeded();
  const box = await page.locator('.reel').boundingBox();
  if (!box) throw new Error('No reel');
  const y = box.y + 120;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 800, y, { steps: frames });
  await page.mouse.up();
}

test.describe('the reel', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('drags without rendering on every frame', async ({ page }) => {
    const counts: number[] = [];
    for (const frames of [8, 80]) {
      await page.goto(consoleUrl({ debug: 'renders' }));
      await ready(page);
      const before = await renders(page);
      await drag(page, frames);
      await expect(page.locator('.reel')).not.toHaveClass(/dragging/);
      counts.push((await renders(page)) - before);
    }
    // React hears where the drag settled, however many frames it drew on the way.
    expect(counts[1]).toBe(counts[0]);
    expect(counts[0]).toBeLessThanOrEqual(3);
  });

  test('settles on a whole card when the drag ends, carried a little further by a flick', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await drag(page, 20);
    await expect(page.locator('.reel')).not.toHaveClass(/dragging/);
    // A card and a third to the left, and half a card more for the flick.
    await expect(page.locator('.transport .count')).toHaveText('10 of 12');
    await expect(page.locator('.card[data-place="centre"]')).toHaveCount(1);
  });

  test('moves with the arrow keys, Home and End, and opens with Enter', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await page.locator('.reel').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => centre(page)).toBe('Sort products by price');
    await page.keyboard.press('Home');
    await expect.poll(() => centre(page)).toBe('pino 10.4.0, and nothing to see');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Search turns away long words' })).toBeVisible();
  });

  test('brings a neighbour to the centre when it is clicked, and opens the centre card', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await page.locator('.card[data-index="10"]').click({ position: { x: 300, y: 40 } });
    await expect.poll(() => centre(page)).toBe('Sort products by price');
    await page.locator('.card[data-place="centre"]').click({ position: { x: 300, y: 40 } });
    await expect(page.getByRole('dialog', { name: 'Sort products by price' })).toBeVisible();
  });

  test('moves the wipe with its handle’s arrow keys', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296' }));
    await ready(page);
    const handle = page.locator('.card[data-place="centre"] .handle');
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect(handle).toHaveAttribute('aria-valuenow', String(before + 5));
  });
});

test.describe('the sheet', () => {
  test('holds focus while open and gives it back when it closes', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296' }));
    await ready(page);
    await page.locator('.reel').focus();
    await page.keyboard.press('Enter');
    const sheet = page.getByRole('dialog', { name: 'Prices go negative' });
    await expect(sheet).toBeVisible();
    await expect(page.locator('#sheet-title')).toBeFocused();
    for (let i = 0; i < 40; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('.sheet') !== null)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.locator('.reel')).toBeFocused();
  });

  test('steps to the previous and next work items, and the reel follows', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    const sheet = page.getByRole('dialog');
    await expect(sheet).toHaveAccessibleName('Prices go negative');
    await sheet.getByRole('button', { name: 'Next work item' }).click();
    await expect(sheet).toHaveAccessibleName('Sort products by price');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect.poll(() => centre(page)).toBe('Sort products by price');
  });

  test('steps through the stages, showing the site as it stood', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1296', sheet: true }));
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /T\+04:20, signal/ })
      .click();
    await expect(page.locator('.site-head')).toContainText('BROKEN · v0.9.4');
    await expect(page.locator('.event.now')).toContainText('The home journey saw a price of £-6.00');
    await page.getByRole('button', { name: 'Next step' }).click();
    await expect(page.locator('.event.now')).toContainText('Triage');
  });
});

test.describe('the line', () => {
  test('opens a stage panel that lists what is in the stage, each opening its sheet', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await page.getByRole('button', { name: /^Plan: needs you/ }).click();
    const panel = page.getByRole('dialog', { name: 'Plan' });
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: /Open #1300/ }).click();
    await expect(page.getByRole('dialog', { name: 'Sort products by price' })).toBeVisible();
  });

  test('closes the stage panel with Escape, back to its station', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    const gates = page.getByRole('button', { name: /^Gates:/ });
    await gates.click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(gates).toBeFocused();
  });
});
