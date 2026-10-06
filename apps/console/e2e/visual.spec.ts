/**
 * Visual regression, in the pinned Playwright image (`make e2e`; UPDATE=1 rewrites the snapshots) with motion off
 * and t fixed: every station in every state in both themes, and the line, one card per picture and the sheet at
 * all three widths. Milestone 4's states come from its test data: a card for each new picture and outcome, the line
 * with tickets waiting and with a spend cap, Triage's panel, a ticket's and a quarantined report's sheets, and an
 * empty store for real events.
 */
import { STAGES as KINDS } from '@software-factory/events';
import {
  consoleUrl,
  emptyStore,
  expect,
  fixtureUrl,
  picturesDecodeAsDrawn,
  picturesShown,
  ready,
  THEMES,
  test,
  WIDTHS,
} from './support.ts';

test.beforeEach(({ page }) => picturesDecodeAsDrawn(page));

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
        await picturesShown(card);
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

/** Milestone 4's states, from the test data: one card for each new picture and outcome. */
const SENSING = {
  'waiting-screenshot': '1001',
  'every-page': '1002',
  'http-redirects': '1003',
  'http-headers': '1004',
  'browser-console': '1005',
  accessibility: '1006',
  quarantined: '1007',
  parked: '1008',
  discarded: '1009',
  'report-ticket': '1010',
};

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, sensing and triage`, () => {
    test.use({ viewport });

    for (const [state, item] of Object.entries(SENSING)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(fixtureUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await card.scrollIntoViewIfNeeded();
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`m04-card-${state}-${width}.png`);
      });
    }

    for (const at of ['afternoon', 'capped'] as const) {
      test(`the line, ${at}`, async ({ page }) => {
        await page.goto(fixtureUrl({ at }));
        await ready(page);
        // The header and any notice with the line: a spend cap is said in all three.
        await expect(page).toHaveScreenshot(`m04-line-${at}-${width}.png`, {
          clip: { x: 0, y: 0, width: viewport.width, height: width === 'phone' ? 760 : 700 },
        });
      });
    }

    test('Triage’s panel, after the cap cleared', async ({ page }) => {
      await page.goto(fixtureUrl({ at: 'cleared' }));
      await ready(page);
      await page.getByRole('button', { name: /^Triage:/ }).click();
      const panel = page.getByRole('dialog', { name: 'Triage' });
      await expect(panel).toHaveScreenshot(`m04-triage-panel-${width}.png`);
    });

    for (const [name, item] of [
      ['ticket', '1000'],
      ['quarantined', '1007'],
    ] as const) {
      test(`a sheet: ${name}`, async ({ page }) => {
        await page.goto(fixtureUrl({ item, sheet: true }));
        await page.getByRole('dialog').first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForLoadState('networkidle');
        await expect(page).toHaveScreenshot(`m04-sheet-${name}-${width}.png`);
      });
    }

    test('an empty store for real events', async ({ page }) => {
      await emptyStore(page, 'real');
      await page.goto(consoleUrl());
      await page.getByText('Watching, nothing yet').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await expect(page).toHaveScreenshot(`m04-empty-real-${width}.png`, { fullPage: true });
    });
  });
}

test.describe('the line in Ink, sensing and triage', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('a spend cap reached', async ({ page }) => {
    await page.goto(fixtureUrl({ at: 'capped', theme: 'ink' }));
    await ready(page);
    await expect(page).toHaveScreenshot('m04-line-capped-ink.png', {
      clip: { x: 0, y: 0, width: WIDTHS.desktop.width, height: 700 },
    });
  });

  test('a ticket’s sheet', async ({ page }) => {
    await page.goto(fixtureUrl({ item: '1000', sheet: true, theme: 'ink' }));
    await page.getByRole('dialog').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveScreenshot('m04-sheet-ticket-ink.png');
  });
});
