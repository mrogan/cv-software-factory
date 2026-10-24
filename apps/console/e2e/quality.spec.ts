import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { adminService, consoleUrl, expect, ready, THEMES, test, WIDTHS } from './support.ts';

/**
 * The reel's neighbours either side of the centre card are faded previews of inactive slides: WCAG 1.4.3 exempts
 * text in an inactive part of the interface, and each is read in full once it is the centre card.
 */
const axe = (page: Page) =>
  new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .exclude('.card[data-place="side"]');

// WCAG 2.2 AA, in both themes, at all three widths, with motion on and off.
for (const [width, viewport] of Object.entries(WIDTHS)) {
  for (const theme of THEMES) {
    for (const motion of [false, true]) {
      test.describe(`${width}, ${theme}, motion ${motion ? 'on' : 'off'}`, () => {
        test.use({ viewport });

        test('the page has nothing for axe to find', async ({ page }) => {
          await page.goto(consoleUrl({ theme, motion }));
          await ready(page);
          expect((await axe(page).analyze()).violations).toEqual([]);
        });

        test('an open stage panel has nothing for axe to find', async ({ page }) => {
          await page.goto(consoleUrl({ theme, motion }));
          await ready(page);
          await page.getByRole('button', { name: /^Gates:/ }).click();
          await page.getByRole('dialog').waitFor();
          expect((await axe(page).analyze()).violations).toEqual([]);
        });

        test('an open sheet has nothing for axe to find', async ({ page }) => {
          await page.goto(consoleUrl({ theme, motion, item: '1296', sheet: true }));
          await page.getByRole('dialog', { name: 'Prices go negative' }).waitFor();
          await page.evaluate(() => document.fonts.ready);
          expect((await axe(page).include('.sheet').analyze()).violations).toEqual([]);
        });
      });
    }
  }
}

// The doors and the account menu, at a phone's width and a desktop's, in both themes.
for (const width of ['phone', 'desktop'] as const) {
  for (const theme of THEMES) {
    test.describe(`${width}, ${theme}, signing in`, () => {
      test.use({ viewport: WIDTHS[width] });

      for (const view of ['sign-in', 'enrol']) {
        test(`the ${view} door has nothing for axe to find`, async ({ page }) => {
          await adminService(page, 'visitor');
          await page.goto(`/?view=${view}&theme=${theme}`);
          await page.locator('.door').waitFor();
          expect((await axe(page).analyze()).violations).toEqual([]);
        });
      }

      test('Martin’s open account menu has nothing for axe to find', async ({ page }) => {
        await adminService(page, 'martin');
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        await page.getByRole('button', { name: 'Martin', exact: true }).click();
        expect((await axe(page).include('header.top').analyze()).violations).toEqual([]);
      });
    });
  }
}

// The line's controls: the header and Controls, Martin's and a visitor's, and Stop the line's and Start the line's
// dialogs, at all three widths, in both themes.
for (const [width, viewport] of Object.entries(WIDTHS)) {
  for (const theme of THEMES) {
    test.describe(`${width}, ${theme}, the line's controls`, () => {
      test.use({ viewport });

      for (const as of ['martin', 'visitor'] as const) {
        test(`the header and Controls, ${as === 'martin' ? 'Martin’s' : 'a visitor’s'}, have nothing for axe to find`, async ({
          page,
        }) => {
          await adminService(page, as);
          await page.goto(consoleUrl({ theme }));
          await ready(page);
          await page.locator('article.controls').waitFor();
          expect((await axe(page).include('header.top').include('article.controls').analyze()).violations).toEqual([]);
        });
      }

      test('Stop the line’s and Start the line’s dialogs have nothing for axe to find', async ({ page }) => {
        await adminService(page, 'martin');
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        await page.getByRole('button', { name: 'Stop the line' }).click();
        await page.getByRole('dialog', { name: 'Stop the line' }).waitFor();
        expect((await axe(page).include('dialog').analyze()).violations).toEqual([]);
        await page.goto(consoleUrl({ theme, at: Date.parse('2026-10-06T06:40:00Z') }));
        await ready(page);
        await page.getByRole('button', { name: 'Start the line (asks for your passkey)' }).click();
        await page.getByRole('dialog', { name: 'Start the line' }).waitFor();
        expect((await axe(page).include('dialog').analyze()).violations).toEqual([]);
      });
    });
  }
}

test('makes no request to another origin, and breaks no policy, as it plays and opens everything', async ({ page }) => {
  // The guard fixture fails the test on either; this walks through everything that loads something.
  await page.goto(consoleUrl({ motion: true }));
  await ready(page);
  for (const item of ['1262', '1268', '1271', '1276', '1288', '1296', '1302', '1304', '1311', '1323']) {
    await page.goto(consoleUrl({ item, sheet: true }));
    await page.getByRole('dialog').waitFor();
    // Lazy images load as they come into view: scroll the sheet to the end.
    await page.locator('.sheet-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForLoadState('networkidle');
  }
});
