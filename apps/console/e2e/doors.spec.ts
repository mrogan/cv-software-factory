/**
 * The console's side of signing in, against a stand-in for the admin service: who the page takes the viewer for, the
 * account menu, what a write sends, and the doors' notes. `signing-in.spec.ts` takes the same doors through the real
 * service with a passkey.
 */
import { adminService, consoleUrl, expect, ready, SESSION, test } from './support.ts';

test('offers no sign-in where there is no admin service to sign in to', async ({ page }) => {
  // The console's server answers `/admin/session` with its own 404, as a cluster before the service's Deployment does.
  await page.goto(consoleUrl());
  await ready(page);
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Martin, signed in' })).toHaveCount(0);
});

test('offers a visitor Martin’s sign-in in the footer, and nothing more', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto(consoleUrl());
  await ready(page);
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveAttribute('href', '/?view=sign-in');
  await expect(page.getByRole('button', { name: 'Martin, signed in' })).toHaveCount(0);
});

test('shows Martin his account, whose menu closes on a click outside', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto(consoleUrl());
  await ready(page);
  const account = page.getByRole('button', { name: 'Martin, signed in' });
  await expect(account).toHaveAttribute('aria-expanded', 'false');
  await account.click();
  await expect(account).toHaveAttribute('aria-expanded', 'true');
  const menu = page.locator('#account-menu');
  // In London, where the tests' browser is: the session's eight hours, from 15:40.
  await expect(menu).toContainText('Signed in with a passkey at 15:40');
  await expect(menu).toContainText('The session ends at 23:40');
  await page.locator('section.intro h1').click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('link', { name: 'Martin’s sign-in' })).toHaveCount(0);
});

test('signs out with a POST of JSON carrying the session’s token, and lands on the door that says so', async ({
  page,
}) => {
  await adminService(page, 'martin');
  const sent: { method: string; type: string | undefined; token: string | undefined; body: string | null }[] = [];
  await page.route('**/admin/sign-out*', (route) => {
    const request = route.request();
    sent.push({
      method: request.method(),
      type: request.headers()['content-type'],
      token: request.headers()['x-csrf-token'],
      body: request.postData(),
    });
    return route.fulfill({ json: { signedOut: 'everywhere' } });
  });
  await page.goto(consoleUrl());
  await ready(page);
  await page.getByRole('button', { name: 'Martin, signed in' }).click();
  // The door asks the service again, which now finds no session.
  await page.unroute('**/admin/session');
  await adminService(page, 'visitor');
  await page.getByRole('button', { name: /Sign out everywhere/ }).click();
  await expect(page).toHaveURL(/\/\?view=sign-in&ended=everywhere$/);
  await expect(page.getByRole('status')).toHaveText(
    'Signed out everywhere: every session on every device has ended, this one too.',
  );
  expect(sent).toEqual([{ method: 'POST', type: 'application/json', token: SESSION.token, body: '{}' }]);
});

test('says when the session ended, and why, in the viewer’s own time', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.goto(`/?view=sign-in&ended=expired&at=${encodeURIComponent(SESSION.expiresAt)}`);
  await expect(page.getByRole('status')).toHaveText(
    'Your session ended at 23:40. A session lasts eight hours from signing in, however busy.',
  );
});

test('sends a signed-in browser from the sign-in door to the console', async ({ page }) => {
  await adminService(page, 'martin');
  await page.goto('/?view=sign-in');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: 'Martin, signed in' })).toBeVisible();
});

test('says the service’s own words when it refuses, and ours when it cannot be reached', async ({ page }) => {
  await adminService(page, 'visitor');
  await page.route('**/admin/sign-in/options', (route) =>
    route.fulfill({
      status: 429,
      json: { refused: 'rate', message: 'Too many tries from here: wait, then try again.' },
    }),
  );
  await page.goto('/?view=sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText('Too many tries from here: wait, then try again.');
  await page.unroute('**/admin/sign-in/options');
  await page.route('**/admin/sign-in/options', (route) => route.abort());
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page.getByRole('alert')).toHaveText('The admin service can’t be reached. Try again in a moment.');
});

test('enrolment: a code that can no longer be used disables the field, and the foot names recovery', async ({
  page,
}) => {
  await adminService(page, 'visitor');
  await page.route('**/admin/enrol/options', (route) =>
    route.fulfill({ status: 403, json: { refused: 'code', message: 'That code can’t be used any more.', left: 0 } }),
  );
  await page.goto('/?view=enrol');
  await expect(page.locator('.steps-list li.past')).toHaveCount(1);
  await page.getByLabel('One-time code').fill('AAAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
  await page.getByRole('button', { name: 'Check the code' }).click();
  await expect(page.getByRole('alert')).toContainText('It has expired, been used, or had its five tries.');
  await expect(page.getByLabel('One-time code')).toBeDisabled();
  await expect(page.getByText('factory admin enrol --revoke-others')).toBeVisible();
});
