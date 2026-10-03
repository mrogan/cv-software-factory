/**
 * Visual regression, in the pinned Playwright image (`make e2e`; UPDATE=1 rewrites the snapshots) with motion off
 * and t fixed: every station in every state in both themes, and the line, one card per picture and the sheet at
 * all three widths.
 */
import { STAGES as KINDS } from '@software-factory/events';
import { consoleUrl, expect, ready, THEMES, test, WIDTHS } from './support.ts';

/** The station kit's states (the design system's README); its module defines an element, so Node cannot load it. */
const STATUSES = ['idle', 'working', 'returning', 'passing', 'blocked', 'failed'] as const;

test.describe('stations', () => {
  for (const theme of THEMES) {
    for (const kind of KINDS) {
      for (const status of STATUSES) {
        test(`${kind}, ${status}, ${theme}`, async ({ page }) => {
          await page.goto(consoleUrl({ theme }));
          await ready(page);
          // One station on its own, on the page's background.
          await page.evaluate(
            ([kind, status]) => {
              const station = document.createElement('sf-station');
              station.setAttribute('kind', kind);
              station.setAttribute('status', status);
              station.setAttribute('motion', 'off');
              const specimen = document.createElement('div');
              specimen.className = 'specimen';
              specimen.append(station);
              document.body.replaceChildren(specimen);
            },
            [kind, status] as const,
          );
          await expect(page.locator('.specimen sf-station')).toHaveScreenshot(`${kind}-${status}-${theme}.png`);
        });
      }
    }
  }
});

/** One card for each kind of picture the design system draws. */
const PICTURES = {
  wipe: '1296',
  metric: '1288',
  logs: '1265',
  package: '1262',
  scan: '1282',
  rollback: '1276',
  refusal: '1274',
  judgement: '1268',
  spec: '1300',
};

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(width, () => {
    test.use({ viewport });

    test('the line', async ({ page }) => {
      await page.goto(consoleUrl());
      await ready(page);
      await expect(page.getByRole('region', { name: 'The line' })).toHaveScreenshot(`line-${width}.png`);
    });

    for (const [picture, item] of Object.entries(PICTURES)) {
      test(`a card with a ${picture} picture`, async ({ page }) => {
        await page.goto(consoleUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await card.scrollIntoViewIfNeeded();
        await card.evaluate((el) =>
          Promise.all([...el.querySelectorAll('img')].map((img) => img.decode().catch(() => undefined))),
        );
        await expect(card).toHaveScreenshot(`card-${picture}-${width}.png`);
      });
    }

    test('the sheet', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1296', sheet: true }));
      await page.getByRole('dialog', { name: 'Prices go negative' }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`sheet-${width}.png`);
    });
  });
}
