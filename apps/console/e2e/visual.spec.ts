/**
 * Visual regression, in the pinned Playwright image (`make e2e`; UPDATE=1 rewrites the snapshots) with motion off
 * and t fixed: every station in every state in both themes, and the line, one card per picture and the sheet at
 * all three widths. Milestone 4's states come from its test data: a card for each new picture and outcome, the line
 * with tickets waiting and with a spend cap, Triage's panel, a ticket's and a quarantined report's sheets, and an
 * empty store for real events. Milestone 5's come from the samples: a card for each wait and hold, Review's panel,
 * and a fix's spec, rounds, review, gates and models, the sheet in Ink too.
 */
import type { Page } from '@playwright/test';
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

/**
 * The station kit's states (the design system's README), and a beacon on a working station; its module defines an
 * element, so Node cannot load it.
 */
const STATES = [
  ...(['idle', 'working', 'returning', 'passing', 'blocked', 'failed'] as const).map((status) => ({
    status,
    name: status,
  })),
  { status: 'working', beacon: 'needs-you', name: 'working-needs-you' },
  { status: 'working', beacon: 'failed', name: 'working-failed' },
] as const;

test.describe('stations', () => {
  for (const theme of THEMES) {
    for (const kind of KINDS) {
      for (const { status, beacon, name } of STATES.map((s) => ({ beacon: undefined, ...s }))) {
        test(`${kind}, ${name}, ${theme}`, async ({ page }) => {
          await page.goto(consoleUrl({ theme }));
          await ready(page);
          // One station on its own, on the page's background.
          await page.evaluate(
            ([kind, status, beacon]) => {
              const station = document.createElement('sf-station');
              station.setAttribute('kind', kind);
              station.setAttribute('status', status);
              if (beacon) station.setAttribute('beacon', beacon);
              station.setAttribute('motion', 'off');
              const specimen = document.createElement('div');
              specimen.className = 'specimen';
              specimen.append(station);
              document.body.replaceChildren(specimen);
            },
            [kind, status, beacon] as const,
          );
          await expect(page.locator('.specimen sf-station')).toHaveScreenshot(`${kind}-${name}-${theme}.png`);
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

/** Milestone 5's states, from the samples: a card for each wait and hold, and a merge waiting for a release. */
const FIXING = {
  'merge-wait': '1311',
  'held-scope': '1315',
  'held-tests-first': '1317',
  'held-spend': '1319',
  'held-still-blocking': '1323',
  merged: '1304',
};

/** A fix's sheet, a part at a time: the parts below the fold are the new ones. */
async function sheetParts(page: Page, item: string, theme: 'paper' | 'ink' = 'paper') {
  await page.goto(consoleUrl({ item, sheet: true, theme }));
  await page.getByRole('dialog').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  const section = (title: string) =>
    page.locator('.sheet .sec').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
  const side = (title: string) =>
    page.locator('.sheet .side-card').filter({ has: page.getByRole('heading', { name: title }) });
  return { section, side };
}

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, fixing`, () => {
    test.use({ viewport });

    for (const [state, item] of Object.entries(FIXING)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await card.scrollIntoViewIfNeeded();
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`m05-card-${state}-${width}.png`);
      });
    }

    test('Review’s panel, with a merge waiting and a round sent back', async ({ page }) => {
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: /^Review:/ }).click();
      await expect(page.getByRole('dialog', { name: 'Review' })).toHaveScreenshot(`m05-review-panel-${width}.png`);
    });

    test('a fix’s sheet: the spec, its rounds and its review', async ({ page }) => {
      const { section } = await sheetParts(page, '1311');
      for (const [title, name] of [
        ['The spec', 'spec'],
        ['Rounds', 'rounds'],
        ['Review', 'review'],
      ] as const) {
        await expect(section(title)).toHaveScreenshot(`m05-sheet-${name}-${width}.png`);
      }
    });

    test('a fix’s sheet: its gates by attempt, and its agents and models', async ({ page }) => {
      const { side } = await sheetParts(page, '1311');
      await expect(side('Gates')).toHaveScreenshot(`m05-sheet-gates-${width}.png`);
      await expect(side('Agents and models')).toHaveScreenshot(`m05-sheet-models-${width}.png`);
      const local = await sheetParts(page, '1304');
      await expect(local.side('Agents and models')).toHaveScreenshot(`m05-sheet-models-local-${width}.png`);
    });
  });
}

test.describe('a fix’s sheet in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the spec, its rounds, its review and its gates', async ({ page }) => {
    const { section, side } = await sheetParts(page, '1311', 'ink');
    await expect(section('The spec')).toHaveScreenshot('m05-sheet-spec-ink.png');
    await expect(section('Rounds')).toHaveScreenshot('m05-sheet-rounds-ink.png');
    await expect(section('Review')).toHaveScreenshot('m05-sheet-review-ink.png');
    await expect(side('Gates')).toHaveScreenshot('m05-sheet-gates-ink.png');
  });
});
