import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { consoleUrl, expect, ready, THEMES, test, WIDTHS } from './support.ts';

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

test('makes no request to another origin, and breaks no policy, as it plays and opens everything', async ({ page }) => {
  // The guard fixture fails the test on either; this walks through everything that loads something.
  await page.goto(consoleUrl({ motion: true }));
  await ready(page);
  for (const item of ['1262', '1268', '1271', '1276', '1288', '1296', '1302']) {
    await page.goto(consoleUrl({ item, sheet: true }));
    await page.getByRole('dialog').waitFor();
    // Lazy images load as they come into view: scroll the sheet to the end.
    await page.locator('.sheet-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight));
    await page.waitForLoadState('networkidle');
  }
});
