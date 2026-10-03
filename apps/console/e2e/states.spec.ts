/**
 * The states the design system's README describes for when there is nothing ordinary to show, each made by
 * standing in for the server's answer.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { consoleUrl, emptyStore, expect, test } from './support.ts';

const noFindings = async (page: Page) =>
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze()).violations).toEqual([]);

test('while connecting, the stations wait, idle, and the header says so', async ({ page }) => {
  await page.route('**/api/events?after=0', () => {});
  await page.goto(consoleUrl());
  await expect(page.locator('header .status')).toHaveText('Connecting to the factory');
  await expect(page.getByRole('button', { name: 'Sense: reading the factory’s events' })).toBeDisabled();
  await noFindings(page);
});

test('when the factory can’t be reached, the console says so and keeps trying', async ({ page }) => {
  let tries = 0;
  await page.route('**/api/events?after=0', (route) => {
    tries++;
    return route.fulfill({ status: 503, body: '' });
  });
  await page.goto(consoleUrl());
  await expect(page.getByRole('status').filter({ hasText: 'Unreachable' })).toBeVisible();
  await expect.poll(() => tries, { timeout: 8000 }).toBeGreaterThan(1);
  await noFindings(page);
});

test('an empty store keeps the idle line, and says where the work will appear', async ({ page }) => {
  await emptyStore(page, null);
  await page.goto(consoleUrl());
  await expect(page.getByText('Nothing yet')).toBeVisible();
  await expect(page.locator('header .status')).toHaveText('Line not started');
  await expect(page.getByRole('button', { name: /^Sense: idle, none/ })).toBeVisible();
  await noFindings(page);
});

test('an empty store for real events says the senses are watching, and sends nobody to the samples', async ({
  page,
}) => {
  await emptyStore(page, 'real');
  await page.goto(consoleUrl());
  await expect(page.getByText('Watching, nothing yet')).toBeVisible();
  await expect(page.getByText('The first tickets usually appear within fifteen minutes.')).toBeVisible();
  await expect(page.getByText('make samples won’t load into it')).toBeVisible();
  await expect(page.getByText('Nothing yet', { exact: true })).toHaveCount(0);
  await noFindings(page);
});

test('a dropped connection keeps the page, and says when it dropped', async ({ page }) => {
  await page.route('**/api/events/stream*', (route) => route.fulfill({ status: 503, body: '' }));
  await page.goto(consoleUrl());
  await expect(page.getByRole('status').filter({ hasText: 'The connection to the factory dropped at' })).toBeVisible();
  await expect(page.locator('header .status')).toHaveText('Reconnecting');
  await expect(page.locator('.card[data-place="centre"]')).toBeVisible();
});

test('events from a newer factory are left out, with a note', async ({ page, request }) => {
  const events = (await (await request.get('/api/events')).json()) as { seq: number }[];
  const last = events.at(-1) ?? { seq: 0 };
  await page.route('**/api/events?after=0', (route) =>
    route.fulfill({ json: [...events, { ...last, seq: last.seq + 1, type: 'robot.danced', version: 1 }] }),
  );
  let after: string | null = null;
  await page.route('**/api/events/stream*', (route) => {
    after = new URL(route.request().url()).searchParams.get('after');
  });
  await page.goto(consoleUrl());
  await expect(page.getByText('One event was written by a newer version of the factory')).toBeVisible();
  await expect(page.locator('.transport .count')).toHaveText('12 of 12');
  // The stream carries on after the event left out, so it is never sent, or counted, twice.
  await expect.poll(() => after).toBe(String(last.seq + 1));
});

test('a screenshot that fails to load says so in its place', async ({ page }) => {
  await page.route('**/artifacts/**', (route) => route.fulfill({ status: 404, body: '' }));
  await page.goto(consoleUrl({ item: '1296' }));
  const card = page.locator('.card[data-place="centre"]');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByRole('img', { name: /It could not be loaded/ }).first()).toBeVisible();
});
