/**
 * Signing in, end to end: the console's doors against the real admin service on a throwaway store, on one origin
 * behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey in the browser. Enrolling with a code
 * from `factory admin enrol` (a wrong one, then the right one), the account menu, signing out and in again, signing
 * out everywhere, a device with no passkey, and a code with no tries left. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { type Harness, startHarness, virtualPasskey } from './admin.ts';
import { expect, keptOnDevice, SESSION_COOKIE, test } from './support.ts';

const PORT = 18_326;

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'signing_in');
});
test.afterAll(async () => {
  await harness?.stop();
});

test('a visitor finds Martin’s sign-in in the footer, and a door with a way back', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(page.getByRole('button', { name: 'Martin', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Martin’s sign-in' }).click();
  await expect(page).toHaveURL(/\?view=sign-in$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeFocused();
  await expect(
    page.getByText('Sign in with the passkey on this device to answer holds, change settings and run the line.'),
  ).toBeVisible();
  await expect(
    page.getByText('Visiting? Everything Martin can change is on the console already, read-only.'),
  ).toBeVisible();
  // Nothing of the console behind the door.
  await expect(page.locator('section.line')).toHaveCount(0);
  await expect(page).toHaveTitle('Sign in · Software Factory');
});

test('enrols a passkey with a one-time code, and is signed in; then signs out, in, and out everywhere', async ({
  page,
}) => {
  await virtualPasskey(page);
  const code = await harness.code();

  await test.step('a wrong code says how many tries are left, across every browser', async () => {
    await page.goto('/?view=enrol');
    await expect(page.getByRole('heading', { name: 'Enrol a passkey' })).toBeFocused();
    await page.getByLabel('One-time code').fill('ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
    await page.getByRole('button', { name: 'Check the code' }).click();
    await expect(page.getByRole('alert')).toHaveText(
      /That code isn’t right\.\s*4 tries left for it, across every browser\./,
    );
  });

  await test.step('the right code, in any case and without its dashes, makes a passkey and signs in', async () => {
    await page.getByLabel('One-time code').fill(code.replaceAll('-', '').toLowerCase());
    await page.getByRole('button', { name: 'Check the code' }).click();
    await page.getByLabel('Name this passkey').fill('Laptop');
    await page.getByRole('button', { name: 'Make a passkey' }).click();
    await expect(page.getByText('Passkey made, and you are signed in on this device.')).toBeVisible();
    await expect(page.locator('.steps-list li.past')).toHaveCount(3);
    await page.getByRole('link', { name: 'Go to the console' }).click();
  });

  await test.step('the console knows Martin: his account, and no way to sign in again', async () => {
    const account = page.getByRole('button', { name: 'Martin', exact: true });
    await expect(account).toBeVisible();
    await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
    await account.click();
    await expect(page.locator('#account-menu')).toContainText('Martin Rogan');
    await expect(page.locator('#account-menu')).toContainText(/Signed in with a passkey at \d\d:\d\d/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#account-menu')).toBeHidden();
    await expect(account).toBeFocused();
    // The cookie is the service's alone: HttpOnly, so this page's script cannot read it.
    expect(await page.evaluate(() => document.cookie)).toBe('');
    // The one thing the console keeps on a device, and only Martin's: no other cookie, and no storage of any kind.
    expect(await keptOnDevice(page)).toEqual([SESSION_COOKIE]);
    const [cookie] = await page.context().cookies();
    expect(cookie).toMatchObject({
      name: '__Host-session',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
      path: '/',
    });
  });

  await test.step('signs out, and the door says so', async () => {
    await page.getByRole('button', { name: 'Martin', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(/\?view=sign-in&ended=here$/);
    await expect(page.getByRole('status')).toHaveText('Signed out. This browser holds no session now.');
    expect(await page.context().cookies()).toEqual([]);
    expect(await keptOnDevice(page)).toEqual([]);
  });

  await test.step('signs in again with the same passkey', async () => {
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('button', { name: 'Martin', exact: true })).toBeVisible();
    await expect(page).toHaveURL(`http://localhost:${PORT}/`);
  });

  await test.step('signs out everywhere', async () => {
    await page.getByRole('button', { name: 'Martin', exact: true }).click();
    await page.getByRole('button', { name: /Sign out everywhere/ }).click();
    await expect(page.getByRole('status')).toHaveText(
      'Signed out everywhere: every session on every device has ended, this one too.',
    );
    const live = await harness.database.owner`select 1 from sessions where ended_at is null`;
    expect(live).toHaveLength(0);
  });

  // Every request carried the cookie toward the proxy; none reached the console's server with it.
  expect(harness.cookiesToConsole).toBeGreaterThan(0);
});

test('a device with no passkey is told how to enrol one, without being told it has none', async ({ page }) => {
  // The browser answers a closed sheet and a device with no passkey alike, so the page cannot tell them apart.
  await virtualPasskey(page);
  await page.goto('/?view=sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toContainText('No passkey was used.');
  await expect(page.getByRole('alert')).toContainText(
    'Either the passkey sheet was closed, or this device has no passkey',
  );
  await page.getByRole('link', { name: 'enrolment page' }).click();
  await expect(page.getByRole('heading', { name: 'Enrol a passkey' })).toBeVisible();
});

test('a code with no tries left says so, and takes no more', async ({ page }) => {
  await harness.code();
  await page.goto('/?view=enrol');
  for (let left = 4; left >= 0; left--) {
    await page.getByLabel('One-time code').fill('ZZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ');
    await page.getByRole('button', { name: 'Check the code' }).click();
    if (left) await expect(page.getByRole('alert')).toContainText(`${left === 1 ? '1 try' : `${left} tries`} left`);
  }
  await expect(page.getByRole('alert')).toContainText('That code can’t be used any more.');
  await expect(page.getByLabel('One-time code')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check the code' })).toBeDisabled();
});
