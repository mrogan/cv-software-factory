/**
 * Milestone 6's Canary panel and scoreboard in the browser, from the samples: what each state says in words, so it
 * reads without colour, that the panel's work items open their sheets, and WCAG 2.2 AA in both themes at a laptop's
 * width and a phone's.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { CANARY, consoleUrl, expect, SCORE, scored, shown, THEMES, test, WIDTHS } from './support.ts';

const panel = (page: Page) => page.getByRole('region', { name: /./ }).and(page.locator('section.canary'));

test.describe('the Canary panel', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('draws the release in flight at the step it is measuring, and opens the work it carries', async ({ page }) => {
    await page.goto(consoleUrl());
    await shown(page);
    const canary = panel(page);
    await expect(canary.locator('.kick')).toHaveText('Canary · 50% of traffic');
    await expect(canary.getByRole('heading', { level: 2 })).toHaveText('The contact form loses your message');
    await expect(canary.getByRole('list', { name: 'The canary’s steps' }).getByRole('listitem')).toHaveText([
      /^25%3 min, passed$/,
      /^50%3 min, measuring now$/,
      /^100%all, to come$/,
    ]);
    await expect(canary.locator('table.measures caption')).toContainText('At the 25% step');
    await expect(page.getByRole('button', { name: /^Release: .*, 50% · 1 waiting\. / })).toBeVisible();
    await canary.getByRole('button', { name: '#1314' }).click();
    await expect(page.getByRole('dialog', { name: 'The contact form loses your message' })).toBeVisible();
  });

  test('says a rollback’s story in words, and links the ticket its signal opened', async ({ page }) => {
    await page.goto(consoleUrl({ at: CANARY['rolled-back-no-step'] }));
    await shown(page);
    const canary = panel(page);
    await expect(canary.locator('.kick')).toHaveText('Rolled back at 25%');
    await expect(canary.getByRole('heading', { level: 2 })).toHaveText('Carries no work item');
    await expect(canary).toContainText('No step was measured: it rolled back 3 min into the 25% step');
    await expect(canary).toContainText('75% of the traffic never saw it: it stayed on v0.9.8.');
    await expect(canary.getByRole('button', { name: '#1308 Slow responses in a canary release' })).toBeVisible();
  });

  test('infers a stop, marks a dry run, and folds to one line when nothing is in flight', async ({ page }) => {
    await page.goto(consoleUrl({ at: CANARY.stopped }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Stopped with the line at 50%');
    await page.goto(consoleUrl({ at: CANARY['dry-run'] }));
    await shown(page);
    await expect(panel(page).locator('.kick')).toHaveText('Canary · 50%, as the dry run records itDry run');
    await expect(panel(page)).toContainText('no image: nothing shipped');
    await page.goto(consoleUrl({ at: CANARY.idle }));
    await shown(page);
    await expect(panel(page)).toContainText('No release in flight The last, v0.9.12, was promoted at 08:06');
  });
});

for (const [width, viewport] of Object.entries({ laptop: WIDTHS.laptop, phone: WIDTHS.phone })) {
  for (const theme of THEMES) {
    test.describe(`the Canary panel, accessible, ${width}, ${theme}`, () => {
      test.use({ viewport });
      for (const [state, at] of Object.entries({ 'in-flight': undefined, ...CANARY })) {
        test(state, async ({ page }) => {
          await page.goto(consoleUrl({ at, theme }));
          await shown(page);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .include('section.canary')
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    });
  }
}

test.describe('the scoreboard', () => {
  test.use({ viewport: WIDTHS.desktop });

  test('says it is off, then counts from nothing, then shows its three figures', async ({ page }) => {
    const intro = page.locator('section.intro');
    await page.goto(consoleUrl({ at: SCORE.off }));
    await scored(page);
    await expect(intro.locator('.score-off')).toHaveText(
      'Scoreboard off This copy of the factory has no answer key, so it counts nothing.',
    );
    await page.goto(consoleUrl({ at: SCORE.first }));
    await scored(page);
    const score = intro.getByRole('group', { name: 'Scoreboard: seeded and injected defects' });
    await expect(score.locator('div')).toHaveText(['0found', '0verified fixed', '—none yetmedian to verified']);
    await page.goto(consoleUrl());
    await scored(page);
    await expect(score.locator('div')).toHaveText([
      /^\d+found$/,
      /^\d+verified fixed$/,
      /^\d[\d a-z]*median to verified$/,
    ]);
  });

  test('draws nothing before the scoreboard has said anything', async ({ page }) => {
    await page.goto(consoleUrl({ at: Date.parse('2026-09-29T07:00:00Z') }));
    await shown(page);
    await expect(page.locator('section.intro').locator('.score, .score-off')).toHaveCount(0);
  });
});

for (const [width, viewport] of Object.entries({ laptop: WIDTHS.laptop, phone: WIDTHS.phone })) {
  for (const theme of THEMES) {
    test.describe(`the scoreboard, accessible, ${width}, ${theme}`, () => {
      test.use({ viewport });
      for (const [state, at] of Object.entries(SCORE)) {
        test(state, async ({ page }) => {
          await page.goto(consoleUrl({ at, theme }));
          await scored(page);
          const results = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
            .include('section.intro')
            .analyze();
          expect(results.violations).toEqual([]);
        });
      }
    });
  }
}
