/**
 * Milestone 5's states in the browser, from the samples' last seven work items: what each says in words, so it reads
 * without colour, and WCAG 2.2 AA in both themes at a laptop's width and a phone's.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { consoleUrl, expect, ready, THEMES, test, WIDTHS } from './support.ts';

const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('.card[data-place="side"]');

const centre = (page: Page) => page.locator('.card[data-place="centre"]');

/** A fact in the sheet's side column: the value after its name. */
const fact = (sheet: Locator, name: string) =>
  sheet.locator('.facts-dl dt', { hasText: name }).locator('xpath=following-sibling::dd[1]');

test.describe('fixing', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('a fix waiting for Martin’s merge shows the pull request, and Review lists the wait', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1311' }));
    await ready(page);
    await expect(centre(page).locator('.out')).toHaveText('Needs you');
    await expect(centre(page).locator('.waits .cap')).toHaveText('PR #1312 · waiting for Martin’s merge');
    await expect(centre(page).locator('.ticks')).toContainText('The reviewer approved, one suggestion');
    await page.getByRole('button', { name: /^Review: needs you, 2 waiting/ }).click();
    await expect(page.getByRole('dialog', { name: 'Review' })).toContainText('Needs you · waiting for Martin’s merge');
  });

  test('a merged fix waits for a release, in the quiet tone, at no cost on the local model', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1304' }));
    await ready(page);
    await expect(centre(page).locator('.out')).toHaveText('Merged · waiting for release');
    await expect(centre(page).getByRole('img', { name: 'Waiting at Release' })).toBeVisible();
    await expect(centre(page).locator('.meta')).toContainText('$0 · local');
    await expect(page.getByRole('button', { name: /^Release: idle, 1 waiting/ })).toBeVisible();
  });

  test('each hold names its mechanism and shows what it judged', async ({ page }) => {
    for (const [item, cap] of [
      ['1315', 'Held at Build · patch outside its scope, twice'],
      ['1317', 'Held at Gates · its tests pass without the fix'],
      ['1319', 'Held at Build · its spend cap reached'],
      ['1323', 'Held at Review · still blocking after two reviews'],
    ]) {
      await page.goto(consoleUrl({ item }));
      await ready(page);
      await expect(centre(page).locator('.out')).toHaveText('Held for a human');
      await expect(centre(page).locator('.waits .cap')).toHaveText(cap ?? '');
    }
  });

  test('a fix’s sheet has its spec, its rounds and its review, with each rule in full', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1311', sheet: true }));
    const sheet = page.getByRole('dialog', { name: 'Quantities over nine are refused' });
    await sheet.waitFor();
    await expect(sheet.locator('.byline')).toContainText('The describer, from the ticket');
    await expect(sheet.locator('table.scope')).toContainText('May change · PR #1312');
    await expect(sheet.locator('table.scope tr', { hasText: 'test/support/shop.ts' })).toContainText('untouched');
    await expect(sheet.locator('.ret-pill')).toHaveText('Review → Build · 2 blocking');
    await expect(sheet.locator('.rounds .after')).toContainText('Described, ready, and waiting for Martin’s merge');
    await expect(sheet.locator('.remark').first()).toContainText('RULE 3Test at the seams.');
    await expect(fact(sheet, 'Reviews')).toHaveText('2 of 2');
    await expect(sheet.locator('.gates .sub')).toHaveText('Signals, not required');
    await expect(sheet).toContainText('Attempt 1 passed every required check; the reviewer sent it back.');
    await expect(sheet.locator('.scrub')).toContainText('DESCRIBED');
  });

  test('a refused path says so to a screen reader, not only by its colour and its line', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1315', sheet: true }));
    const row = page.getByRole('dialog').locator('table.scope tr', { hasText: 'src/catalogue.ts' });
    await expect(row).toContainText('(outside the scope, refused)');
    await expect(page.getByRole('dialog').locator('table.scope')).toContainText('May change · patch 2, refused');
  });

  test('a fix sent back by the gates and then the reviewer counts one review of two', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1325', sheet: true }));
    const sheet = page.getByRole('dialog');
    await expect(fact(sheet, 'Reviews')).toHaveText('1 of 2');
    await expect(sheet.locator('.round-h').first()).toContainText('Review 1');
    await expect(sheet.locator('.round-h').first()).toContainText('attempt 2');
  });

  test('a local model’s row has no company’s logo, and costs $0', async ({ page }) => {
    await page.goto(consoleUrl({ item: '1304', sheet: true }));
    const models = page.getByRole('dialog').locator('table.models');
    await expect(models.locator('tbody tr').first()).toContainText('Qwen3.8 27B · local');
    await expect(models.locator('tbody tr').last()).toContainText('Describer');
    await expect(models.locator('.logo use')).toHaveCount(0);
    await expect(models.locator('tfoot')).toContainText('Total · all local');
    await expect(models).not.toContainText('$0.00');
  });

  test('the line draws a round from what the return records, in the line’s words', async ({ page }) => {
    await page.goto(consoleUrl());
    await ready(page);
    await expect(page.locator('.ret-pill')).toHaveText('#1325 · round 3 · 1 blocking');
  });
});

// WCAG 2.2 AA for every new state, in both themes, on a laptop and a phone, with motion off.
for (const width of ['laptop', 'phone'] as const) {
  for (const theme of THEMES) {
    test.describe(`fixing, ${width}, ${theme}`, () => {
      test.use({ viewport: WIDTHS[width] });

      for (const item of ['1304', '1311', '1315', '1317', '1319', '1323']) {
        test(`the card for #${item} has nothing for axe to find`, async ({ page }) => {
          await page.goto(consoleUrl({ item, theme }));
          await ready(page);
          expect((await axe(page).include('.card[data-place="centre"]').analyze()).violations).toEqual([]);
        });
      }

      test('Review’s panel has nothing for axe to find', async ({ page }) => {
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        await page.getByRole('button', { name: /^Review:/ }).click();
        await page.getByRole('dialog').waitFor();
        expect((await axe(page).include('#stage-panel').analyze()).violations).toEqual([]);
      });

      for (const item of ['1304', '1311', '1315', '1323']) {
        test(`the sheet for #${item} has nothing for axe to find`, async ({ page }) => {
          await page.goto(consoleUrl({ item, sheet: true, theme }));
          await page.getByRole('dialog').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          expect((await axe(page).include('.sheet').analyze()).violations).toEqual([]);
        });
      }
    });
  }
}
