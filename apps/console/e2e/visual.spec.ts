/**
 * Visual regression, in the pinned Playwright image (`make e2e`; UPDATE=1 rewrites the snapshots) with motion off
 * and t fixed: every station in every state in both themes, and the line, one card per picture and the sheet at
 * all three widths. Milestone 4's states come from its test data: a card for each new picture and outcome, the line
 * with tickets waiting and with a spend cap, Triage's panel, a ticket's and a quarantined report's sheets, and an
 * empty store for real events. Milestone 5's come from the samples: a card for each wait and hold, Review's panel,
 * Plan's with a ticket in hand, and a fix's spec, rounds, review, gates and models, the sheet in Ink too. Milestone 6's
 * come from the samples too: the Canary panel in each state, a reopened card and one waiting for Martin's deploy, a
 * sheet's releases, the scrubber for work that goes round three times, and the timeline's versions, a release with no
 * work item's among them. Milestone 7's from a stand-in for the admin service: the sign-in and enrolment doors, a code
 * refused, Martin's account menu, a visitor's report quoted on his sheet, Preview as visitor, the settings for Martin
 * with a change unsaved and for a visitor, and the bottom row: Needs you (Waiting on Martin for a visitor, his words
 * being written for him, the passkey asked for on a guardrail's Approve, and nothing waiting) beside Controls; and the
 * audit log, whole and narrowed to a visitor's report; and the privacy page.
 */
import type { Page } from '@playwright/test';
import { STAGES as KINDS } from '@software-factory/events';
import {
  adminService,
  CANARY,
  consoleUrl,
  emptyStore,
  expect,
  fixtureUrl,
  MERGE_WAITING,
  picturesDecodeAsDrawn,
  picturesShown,
  ready,
  SCORE,
  scored,
  shown,
  THEMES,
  test,
  WIDTHS,
} from './support.ts';

/** A time in the samples when nothing waits on Martin: the first work item is open, and its hold has not started. */
const NOTHING_WAITS = Date.parse('2026-09-29T08:32:00Z');
/** A moment the samples have the line stopped, with Martin's reason: after his stop, before he starts it again. */
const STOPPED = Date.parse('2026-10-06T06:40:00Z');

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
      // One page for all of a kind's states: each is drawn fresh, alone on the page's background, in place of the
      // last. Soft, so a state that differs doesn't stop the rest being compared, and the report names each one.
      test(`${kind}, ${theme}`, async ({ page }) => {
        // A picture that never settles is retried for expect's five seconds: time enough for all eight to be.
        test.slow();
        await page.goto(consoleUrl({ theme }));
        await ready(page);
        for (const { status, beacon, name } of STATES.map((s) => ({ beacon: undefined, ...s }))) {
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
          await expect
            .soft(page.locator('.specimen sf-station'), name)
            .toHaveScreenshot(`${kind}-${name}-${theme}.png`);
        }
      });
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

/**
 * Milestone 5's states, from the samples: a card for each wait and hold, and a merge waiting for a release, which is a
 * dry run's now that every other merge waits for Martin's deploy.
 */
const FIXING: Record<string, { item: string; at?: number }> = {
  'merge-wait': { item: '1311' },
  'held-scope': { item: '1315' },
  'held-tests-first': { item: '1317' },
  'held-spend': { item: '1319' },
  'held-still-blocking': { item: '1323' },
  merged: { item: '1310', at: MERGE_WAITING },
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

    for (const [state, { item, at }] of Object.entries(FIXING)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ item, at }));
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

    test('Plan’s panel, with a ticket in hand, one held and newer ones waiting', async ({ page }) => {
      // In the samples, the planner has taken #1314 and #1315 has just opened behind it.
      await page.goto(consoleUrl({ at: Date.parse('2026-10-06T08:12:30Z') }));
      await ready(page);
      await page.getByRole('button', { name: /^Plan:/ }).click();
      // The screenshot scrolls the panel into view, which would move a row under the pointer left on the station and
      // show it hovered: scroll first, then rest the pointer on the panel's heading.
      const dialog = page.getByRole('dialog', { name: 'Plan' });
      await dialog.scrollIntoViewIfNeeded();
      await dialog.getByRole('heading', { name: 'Plan' }).hover();
      await expect(dialog).toHaveScreenshot(`m05-plan-panel-${width}.png`);
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

    test('a fix’s sheet: an approval’s suggestion sent back, and declined', async ({ page }) => {
      const { section } = await sheetParts(page, '1304');
      await expect(section('Rounds')).toHaveScreenshot(`m05-sheet-rounds-declined-${width}.png`);
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

/** Milestone 6's Canary panel, from the samples: in flight, and each way a release ends, at every width. */
const PANEL = { 'in-flight': undefined, ...CANARY };

/** Milestone 6's cards: a ticket open again, and a merge waiting for Martin's deploy. */
const SHIPPED_CARDS = { reopened: '1306', 'deploy-wait': '1321' };

/** A sheet's releases: twice round and verified, a rollback, a dry run, and the wait for Martin's deploy. */
const SHIPPED = { 'twice-round': '1306', 'rolled-back': '1276', 'dry-run': '1310', 'deploy-wait': '1321' };

for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, shipping`, () => {
    test.use({ viewport });

    for (const [state, at] of Object.entries(PANEL)) {
      test(`the Canary panel: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ at }));
        await shown(page);
        await expect(page.locator('section.canary')).toHaveScreenshot(`m06-canary-${state}-${width}.png`);
      });
    }

    for (const [state, item] of Object.entries(SHIPPED_CARDS)) {
      test(`a card: ${state}`, async ({ page }) => {
        await page.goto(consoleUrl({ item }));
        await ready(page);
        const card = page.locator('.card[data-place="centre"]');
        await picturesShown(card);
        await expect(card).toHaveScreenshot(`m06-card-${state}-${width}.png`);
      });
    }

    for (const [state, item] of Object.entries(SHIPPED)) {
      test(`a sheet’s Release and Verify: ${state}`, async ({ page }) => {
        // Tall enough that the section is in the sheet whole, at every width.
        await page.setViewportSize({ ...viewport, height: 2400 });
        const { section } = await sheetParts(page, item);
        const part = section('Release and Verify');
        await picturesShown(part);
        await expect(part).toHaveScreenshot(`m06-sheet-release-${state}-${width}.png`);
      });
    }

    test('the timeline, with the versions of releases that carry no work item', async ({ page }) => {
      await page.goto(consoleUrl({ item: '1306' }));
      await ready(page);
      await expect(page.locator('.rail')).toHaveScreenshot(`m06-timeline-${width}.png`);
    });

    test('a sheet’s scrubber, for work that goes round three times', async ({ page }) => {
      const { section } = await sheetParts(page, '1306');
      await expect(section('How it went')).toHaveScreenshot(`m06-sheet-scrubber-${width}.png`);
      await page.getByRole('button', { name: /^Pass 2/ }).click();
      await expect(section('How it went')).toHaveScreenshot(`m06-sheet-scrubber-pass-2-${width}.png`);
    });
  });
}

test.describe('the Canary panel in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  for (const state of ['in-flight', 'rolled-back-no-step', 'dry-run'] as const) {
    test(state, async ({ page }) => {
      await page.goto(consoleUrl({ at: PANEL[state], theme: 'ink' }));
      await shown(page);
      await expect(page.locator('section.canary')).toHaveScreenshot(`m06-canary-${state}-ink.png`);
    });
  }

  test('a sheet’s Release and Verify', async ({ page }) => {
    await page.setViewportSize({ ...WIDTHS.desktop, height: 2400 });
    const { section } = await sheetParts(page, '1306', 'ink');
    const part = section('Release and Verify');
    await picturesShown(part);
    await expect(part).toHaveScreenshot('m06-sheet-release-ink.png');
  });
});

/** Milestone 6's scoreboard beside the app's name, from the samples: off, before the first fix, and with figures. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the scoreboard`, () => {
    test.use({ viewport });

    for (const theme of THEMES) {
      for (const [state, at] of Object.entries(SCORE)) {
        test(`${state}, ${theme}`, async ({ page }) => {
          await page.goto(consoleUrl({ at, theme }));
          await scored(page);
          await expect(page.locator('section.intro')).toHaveScreenshot(`m06-score-${state}-${width}-${theme}.png`);
        });
      }
    }
  });
}

/** A door drawn, with the fonts it is set in. */
async function door(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('.door').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Milestone 7: the doors, and Martin's account menu, against a stand-in for the admin service. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, signing in`, () => {
    test.use({ viewport });

    test('the sign-in door', async ({ page }) => {
      await adminService(page, 'visitor');
      await door(page, '/?view=sign-in');
      await expect(page).toHaveScreenshot(`m07-sign-in-${width}.png`);
    });

    test('the enrolment door, and a wrong code', async ({ page }) => {
      await adminService(page, 'visitor');
      await page.route('**/admin/enrol/options', (route) =>
        route.fulfill({ status: 403, json: { refused: 'code', message: 'That code isn’t right.', left: 3 } }),
      );
      await door(page, '/?view=enrol');
      await expect(page).toHaveScreenshot(`m07-enrol-${width}.png`);
      await page.getByLabel('One-time code').fill('AAAAAA-AAAAA-AAAAA-AAAAA-AAAAB');
      await page.getByRole('button', { name: 'Check the code' }).click();
      await page.getByRole('alert').waitFor();
      await expect(page).toHaveScreenshot(`m07-enrol-wrong-${width}.png`);
    });

    test('Martin’s account menu', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: 'Martin', exact: true }).click();
      await page.locator('#account-menu').waitFor();
      await expect(page).toHaveScreenshot(`m07-account-menu-${width}.png`, {
        clip: { x: 0, y: 0, width: viewport.width, height: 320 },
      });
    });

    test('a visitor’s report, quoted on Martin’s sheet', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ item: '1268', sheet: true }));
      await page.locator('.report-said').waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveScreenshot(`m07-sheet-report-${width}.png`);
    });

    test('Preview as visitor', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      // Narrower than a desktop, it is in the account menu.
      if (width !== 'desktop') await page.getByRole('button', { name: 'Martin', exact: true }).click();
      await page.getByRole('button', { name: 'Preview as visitor' }).click();
      await ready(page);
      await page.getByRole('button', { name: 'Back to admin' }).blur();
      await expect(page).toHaveScreenshot(`m07-preview-${width}.png`, {
        clip: { x: 0, y: 0, width: viewport.width, height: 360 },
      });
    });
  });
}

test.describe('the doors in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the sign-in door, after the session ended', async ({ page }) => {
    await adminService(page, 'visitor');
    await door(page, '/?view=sign-in&theme=ink&ended=expired&at=2026-10-06T15%3A10%3A00Z');
    await expect(page).toHaveScreenshot('m07-sign-in-ended-ink.png');
  });
});

/** Milestone 7: the settings, for Martin with a change unsaved and for a visitor, and the bottom row. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the settings`, () => {
    test.use({ viewport });

    test('the settings, with a change unsaved', async ({ page }) => {
      await adminService(page, 'martin');
      await settingsPage(page);
      await page.getByLabel('The coder’s effort').selectOption('high');
      await expect(page).toHaveScreenshot(`m07-settings-${width}.png`, { fullPage: true });
    });

    test('the settings, for a visitor', async ({ page }) => {
      await adminService(page, 'visitor');
      await settingsPage(page);
      await expect(page).toHaveScreenshot(`m07-settings-visitor-${width}.png`, { fullPage: true });
    });

    test('the bottom row, for a visitor', async ({ page }) => {
      await adminService(page, 'visitor');
      await page.goto(consoleUrl());
      await ready(page);
      await expect(page.locator('.bottom')).toHaveScreenshot(`m07-bottom-visitor-${width}.png`);
    });

    test('the bottom row, for Martin, answering in words', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.locator('article.needs h2', { hasText: 'Needs you' }).waitFor();
      const card = page.locator('.need').filter({ hasText: '#1300 ·' });
      await card.getByRole('button', { name: 'Answer in words' }).click();
      await card.getByLabel('Your answer to #1300').fill('Out of stock last, whatever the price.');
      await card.getByLabel('Your answer to #1300').blur();
      await expect(page.locator('.bottom')).toHaveScreenshot(`m07-bottom-martin-${width}.png`);
    });

    test('Approve on a gate’s hold, asking for the passkey again', async ({ page }) => {
      await adminService(page, 'martin');
      await page.route('**/admin/holds/**', (route) =>
        route.fulfill({ status: 403, json: { refused: 'step-up', message: 'This needs your passkey again.' } }),
      );
      await page.goto(consoleUrl());
      await ready(page);
      const card = page.locator('.need').filter({ hasText: '#1274 ·' });
      await card.getByRole('button', { name: 'Approve (asks for your passkey)' }).click();
      await page.getByRole('dialog', { name: 'Approve #1274' }).waitFor();
      await expect(page).toHaveScreenshot(`m07-needs-step-up-${width}.png`);
    });

    test('Needs you, with nothing waiting', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ at: NOTHING_WAITS }));
      await ready(page);
      await page.locator('article.needs h2', { hasText: 'Needs you' }).waitFor();
      await expect(page.locator('article.needs')).toHaveScreenshot(`m07-needs-empty-${width}.png`);
    });
  });
}

test.describe('the settings in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the settings, with a change unsaved', async ({ page }) => {
    await adminService(page, 'martin');
    await settingsPage(page, 'ink');
    await page.getByLabel('The coder’s effort').selectOption('high');
    await expect(page).toHaveScreenshot('m07-settings-ink.png', { fullPage: true });
  });

  test('the bottom row, for a visitor', async ({ page }) => {
    await adminService(page, 'visitor');
    await page.goto(consoleUrl({ theme: 'ink' }));
    await ready(page);
    await expect(page.locator('.bottom')).toHaveScreenshot('m07-bottom-visitor-ink.png');
  });

  test('the bottom row, for Martin', async ({ page }) => {
    await adminService(page, 'martin');
    await page.goto(consoleUrl({ theme: 'ink' }));
    await ready(page);
    await page.locator('article.needs h2', { hasText: 'Needs you' }).waitFor();
    await expect(page.locator('.bottom')).toHaveScreenshot('m07-bottom-martin-ink.png');
  });
});

/** Milestone 7: Stop the line and Start the line in the header, and choosing what the line takes in Controls. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the line's controls`, () => {
    test.use({ viewport });

    test('Stop the line, with a reason', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      await page.getByRole('button', { name: 'Stop the line' }).click();
      const dialog = page.getByRole('dialog', { name: 'Stop the line' });
      await dialog.getByLabel('Reason').fill('Holding releases while I look at the deploy');
      await dialog.getByLabel('Reason').blur();
      await expect(page).toHaveScreenshot(`m07-stop-${width}.png`);
    });

    test('the header while the line is stopped, for a visitor', async ({ page }) => {
      await adminService(page, 'visitor');
      await page.goto(consoleUrl({ at: STOPPED }));
      await ready(page);
      await expect(page).toHaveScreenshot(`m07-stopped-${width}.png`, {
        clip: { x: 0, y: 0, width: viewport.width, height: 240 },
      });
    });

    test('Start the line, with a reason and the passkey', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl({ at: STOPPED }));
      await ready(page);
      await page.getByRole('button', { name: 'Start the line (asks for your passkey)' }).click();
      const dialog = page.getByRole('dialog', { name: 'Start the line' });
      await dialog.getByLabel('Reason').fill('The deploy is fine');
      await dialog.getByLabel('Reason').blur();
      await expect(page).toHaveScreenshot(`m07-start-${width}.png`);
    });

    test('Controls, choosing Just one', async ({ page }) => {
      await adminService(page, 'martin');
      await page.goto(consoleUrl());
      await ready(page);
      const controls = page.locator('article.controls');
      await controls.getByRole('button', { name: 'Just one' }).click();
      await controls.getByLabel('Work item #').fill('1329');
      await controls.getByLabel('Work item #').blur();
      await expect(controls).toHaveScreenshot(`m07-controls-just-one-${width}.png`);
    });
  });
}

test.describe("the line's controls in Ink", () => {
  test.use({ viewport: WIDTHS.desktop });

  test('Stop the line, with a reason', async ({ page }) => {
    await adminService(page, 'martin');
    await page.goto(consoleUrl({ theme: 'ink' }));
    await ready(page);
    await page.getByRole('button', { name: 'Stop the line' }).click();
    await page.getByRole('dialog', { name: 'Stop the line' }).getByLabel('Reason').fill('Holding releases');
    await page.getByRole('dialog', { name: 'Stop the line' }).getByLabel('Reason').blur();
    await expect(page).toHaveScreenshot('m07-stop-ink.png');
  });
});

/** Milestone 7: the audit log, the same for everyone, as a visitor reads it. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the audit log`, () => {
    test.use({ viewport });

    test('the audit log', async ({ page }) => {
      await adminService(page, 'visitor');
      await auditPage(page);
      await expect(page).toHaveScreenshot(`m07-audit-${width}.png`);
    });

    test('the audit log, narrowed to a visitor’s report', async ({ page }) => {
      await adminService(page, 'visitor');
      await auditPage(page, 'paper', '&item=1329');
      await expect(page).toHaveScreenshot(`m07-audit-report-${width}.png`, { fullPage: true });
    });
  });
}

test.describe('the audit log in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the audit log', async ({ page }) => {
    await adminService(page, 'visitor');
    await auditPage(page, 'ink');
    await expect(page).toHaveScreenshot('m07-audit-ink.png');
  });
});

/** The privacy page, from the footer, as a visitor reads it. */
for (const [width, viewport] of Object.entries(WIDTHS)) {
  test.describe(`${width}, the privacy page`, () => {
    test.use({ viewport });

    test('the privacy page', async ({ page }) => {
      await adminService(page, 'visitor');
      await privacyPage(page);
      await expect(page).toHaveScreenshot(`privacy-${width}.png`, { fullPage: true });
    });
  });
}

test.describe('the privacy page in Ink', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('the privacy page', async ({ page }) => {
    await adminService(page, 'visitor');
    await privacyPage(page, 'ink');
    await expect(page).toHaveScreenshot('privacy-ink.png', { fullPage: true });
  });
});

/** The privacy page drawn, with the fonts it is set in. */
async function privacyPage(page: Page, theme: 'paper' | 'ink' = 'paper') {
  await page.goto(`${consoleUrl({ theme })}&view=privacy`);
  await page.locator('.privacy-page').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The audit log drawn, with the fonts it is set in. */
async function auditPage(page: Page, theme: 'paper' | 'ink' = 'paper', more = '') {
  await page.goto(`${consoleUrl({ theme })}&view=audit${more}`);
  await page.locator('table.audit tbody tr:not(.day)').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** The settings page drawn, with the fonts it is set in. */
async function settingsPage(page: Page, theme: 'paper' | 'ink' = 'paper') {
  await page.goto(`${consoleUrl({ theme })}&view=settings`);
  await page.getByRole('heading', { level: 1 }).waitFor();
  await page.evaluate(() => document.fonts.ready);
}
