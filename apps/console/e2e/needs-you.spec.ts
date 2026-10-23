/**
 * Needs you, end to end: the bottom row's cards against the real admin service on a throwaway store holding the
 * samples, on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey. A visitor sees
 * answers the planner's question and its card moves to Answered today; answers the visitor's suggestion in words, which
 * leave it held; and approving the gate's hold asks for his passkey again first. A refusal shows on the card. Then a
 * visitor sees the same cards, read only, as Waiting on Martin, with his answers today but not his words on the
 * visitor's suggestion. Answered today is the viewer's own day, so the answers checked are the ones made here, now. Snapshots are
 * `visual.spec.ts`'s. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { MARTINS_WORDS } from './full.ts';
import { expect, test } from './support.ts';

const PORT = 18_334;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'needs_you');
});
test.afterAll(async () => {
  await harness?.stop();
});

const panel = (page: Page) => page.locator('article.needs');
const card = (page: Page, workItem: string) =>
  panel(page)
    .locator('.need')
    .filter({ has: page.getByText(`#${workItem} ·`, { exact: false }) });
const answers = (workItem: string) =>
  harness.database.owner<{ payload: { decision: string; answer?: string; hold?: string } }[]>`
    select payload from events where work_item = ${workItem} and type = 'hold.answered' order by seq`;

test('Martin answers a card, which moves to Answered today, and gives his passkey again to approve a gate’s hold', async ({
  page,
}) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Needs you');
  await expect(panel(page).locator('.count-attn')).toHaveText('9 waiting');

  await test.step('Approving the planner’s question asks for nothing', async () => {
    const question = card(page, '1300');
    await expect(question.locator('.kick b')).toHaveText('The planner asks');
    await question.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(async () => (await answers('1300')).map((a) => a.payload.decision)).toEqual(['approved']);
    await expect(question).toHaveCount(0);
    await expect(panel(page).locator('.answered')).toContainText('#1300 · Approved. The line carried on.');
  });

  await test.step('Words on the visitor’s suggestion leave it held', async () => {
    const suggestion = card(page, '1329');
    await suggestion.getByRole('button', { name: 'Answer in words' }).click();
    const field = suggestion.getByLabel('Your answer to #1329');
    await expect(field).toBeFocused();
    // A visitor's report opened it: his words stay his, and the field says so.
    await expect(suggestion).toContainText(
      'Your words stay yours: a visitor’s report opened this, so no visitor and no agent reads them.',
    );
    await field.fill('Ask again when improvements ship');
    await expect(suggestion).toContainText('32 / 300');
    await suggestion.getByRole('button', { name: 'Send' }).click();
    await expect
      .poll(async () => (await answers('1329')).map((a) => a.payload.answer))
      .toEqual([MARTINS_WORDS, 'Ask again when improvements ship']);
    await expect(panel(page).locator('.answered')).toContainText(
      '#1329 · Answered in words, still held. Ask again when improvements ship',
    );
    // His own words, which visitors do not see, he does.
    await expect(suggestion).toBeVisible();
  });

  await test.step('Approving the gate’s hold carries the key, and asks for the passkey again', async () => {
    const gate = card(page, '1274');
    const approve = gate.getByRole('button', { name: 'Approve (asks for your passkey)' });
    await approve.click();
    const dialog = page.getByRole('dialog', { name: 'Approve #1274' });
    await expect(dialog).toContainText('Sends it back to the coder for one more round, past the gates’ limit.');
    await expect(dialog).toContainText('Approving overrides a guardrail, so it needs your passkey again.');
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect.poll(async () => (await answers('1274')).map((a) => a.payload.decision)).toEqual(['approved']);
    await expect(gate).toHaveCount(0);
    await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left');
  });

  await test.step('a refusal shows on the card', async () => {
    // Answered from elsewhere meanwhile: the service refuses, and the card says why.
    const scope = card(page, '1315');
    await page.route('**/admin/holds/1315/reject', (route) =>
      route.fulfill({
        status: 409,
        json: { refused: 'hold', message: '#1315 has no hold waiting now: it was answered, or moved on.' },
      }),
    );
    await scope.getByRole('button', { name: 'Reject' }).click();
    await expect(scope.getByRole('alert')).toHaveText('#1315 has no hold waiting now: it was answered, or moved on.');
  });
});

test('a visitor sees what waits on Martin, read only, and not his words on a visitor’s report', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(panel(page).getByRole('heading', { level: 2 })).toHaveText('Waiting on Martin');
  // Two of the samples' nine holds Martin answered above.
  await expect(panel(page).locator('.count-attn')).toHaveText('7 waiting');
  const review = card(page, '1323');
  await expect(review.locator('.kick b')).toHaveText('Held by review');
  await expect(review.locator('.ro')).toHaveText(['Approve', 'Answer in words', 'Reject']);
  await expect(review).toContainText('Martin answers, signed in');
  await expect(panel(page).getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // A deploy takes only his rejection: approving or words would leave it waiting just the same.
  await expect(card(page, '1321').locator('.ro')).toHaveText(['Reject']);
  // His words on the visitor's suggestion stay his; his approval of the planner's question is public.
  const today = panel(page).locator('.answered');
  await expect(today).toContainText(
    '#1329 · Answered in words, still held. His words stay his: the hold was about a visitor’s report.',
  );
  await expect(today).toContainText('#1300 · Approved. The line carried on.');
  await expect(today).not.toContainText('Ask again when improvements ship');
  const scan = await new AxeBuilder({ page })
    .include('.bottom')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(scan.violations).toEqual([]);
});
