/**
 * Martin's view, end to end: the console against the real admin service and the console's own server, both on one
 * throwaway store holding the samples (`admin.ts`), with a virtual passkey in the browser. Signed in, the page reads
 * the full events and shows him a visitor's report text, made plain; a visitor reads the public ones, which carry none.
 * Preview as visitor reads the public events from the console's server, and Back to admin the full ones again. A
 * session ended elsewhere closes the stream, and the page goes to the sign-in door. Needs Postgres: TEST_DATABASE_URL,
 * or Docker.
 */
import type { Page } from '@playwright/test';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { REPORT_SHOWN } from './full.ts';
import { expect, test } from './support.ts';

const PORT = 18_328;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'martins_view');
});
test.afterAll(async () => {
  await harness?.stop();
});

const SHEET = '/?motion=off&item=1268&sheet';
const WITHHELD = 'A visitor’s report from /contact.';

/** The event streams the page opens, by path, as they open. */
function streams(page: Page): string[] {
  const opened: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.endsWith('/stream')) opened.push(pathname);
  });
  return opened;
}

test('a visitor reads the public events, and no report’s text', async ({ page }) => {
  const opened = streams(page);
  await page.goto(SHEET);
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(WITHHELD);
  await expect(sheet.locator('.report-said')).toHaveCount(0);
  expect(opened).toEqual(['/api/events/stream']);
});

test('Martin reads the full events, previews as a visitor, and comes back', async ({ page }) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  const opened = streams(page);

  await test.step('signed in, the sheet quotes the report, made plain and inserted as text', async () => {
    await page.goto(SHEET);
    const said = page.getByRole('dialog').locator('.report-said');
    await expect(said).toContainText('Only you see this: a visitor wrote it');
    await expect(said.locator('blockquote')).toHaveText(REPORT_SHOWN);
    // The visitor's `<b>` is two letters, not markup.
    await expect(said.locator('b')).toHaveCount(0);
    await expect.poll(() => opened.includes('/admin/events/stream')).toBe(true);
    await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
  });

  await test.step('Preview as visitor reads the public events from the console’s server', async () => {
    opened.length = 0;
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Preview as visitor' }).click();
    const banner = page.getByRole('region', { name: 'Preview as visitor' });
    await expect(banner).toContainText(
      'Previewing as a visitor: the public stream, as the server sends it to anyone without your session. You are still signed in.',
    );
    await expect(page.getByRole('button', { name: 'Back to admin' })).toBeFocused();
    await expect(page.locator('header.top')).toContainText('VISITOR VIEW');
    await expect(page.getByRole('button', { name: 'Martin', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
    await expect.poll(() => opened).toEqual(['/api/events/stream']);

    await page.locator('.card[data-place="centre"]').click({ position: { x: 300, y: 40 } });
    const sheet = page.getByRole('dialog');
    await expect(sheet).toContainText(WITHHELD);
    await expect(sheet.locator('.report-said')).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  });

  await test.step('Back to admin reads the full events again', async () => {
    opened.length = 0;
    await page.getByRole('button', { name: 'Back to admin' }).click();
    await expect(page.getByRole('region', { name: 'Preview as visitor' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Martin', exact: true })).toBeVisible();
    await expect.poll(() => opened).toEqual(['/admin/events/stream']);
    await page.locator('.card[data-place="centre"]').click({ position: { x: 300, y: 40 } });
    await expect(page.getByRole('dialog').locator('.report-said blockquote')).toHaveText(REPORT_SHOWN);
  });

  await test.step('a session ended elsewhere closes the stream, and the page goes to the sign-in door', async () => {
    await harness.database.owner`update sessions set ended_at = now(), ended_by = 'revoked' where ended_at is null`;
    await expect(page).toHaveURL(/\?view=sign-in&ended=here$/, { timeout: 15_000 });
  });
});
