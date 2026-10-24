/**
 * The line's controls, end to end: Stop the line and Start the line in the header, and Controls' autonomy level,
 * switches and take, against the real admin service on a throwaway store holding the samples (at Guarded, taking the
 * next five), on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey. The app's
 * Rollout is the harness's stand-in, at the samples' release in flight, which the store records as the line would.
 *
 * A visitor sees every control read-only, and no Stop or Start. Martin stops the line with a reason, which aborts the
 * canary in flight, and the header says why for everyone; starting it asks for his passkey in its own dialog. Then he
 * tightens autonomy at once, loosens it with the passkey again, turns agents' new work off and on, widens and narrows
 * what the line takes, and a take the service refuses says why under it. Snapshots are `visual.spec.ts`'s, and axe's
 * look is `quality.spec.ts`'s. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { VERSIONS } from '@software-factory/events';
import { appendMartins } from '../../factory/src/admin/store.ts';
import { enrolThroughTheDoor, type Harness, Rollout, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_336;
const RELEASE = 'v8q7chmx72-913';
const REASON = 'Holding releases while I look at the deploy';

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;
const rollout = new Rollout();
/** The last event before the tests: the samples, and the release in flight. */
let before = 0;

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'line_controls', {
    rollout: { namespace: 'website', name: 'website' },
    kube: rollout,
  });
  // The line's record of the release in flight, as the samples have it.
  const line = harness.database.as.line;
  await line.begin((tx) =>
    appendMartins(line, tx, [
      {
        id: randomUUID(),
        ts: new Date().toISOString(),
        work_item: null,
        type: 'release.started',
        version: VERSIONS['release.started'],
        actor: 'rollouts',
        summary: 'Canary of v0.9.13 started',
        payload: {
          release: RELEASE,
          version: 'v0.9.13',
          previous: 'v0.9.12',
          image: { digest: `sha256:${'6'.repeat(64)}`, signed: true, admitted: true },
          watched: true,
          steps: null,
          dryRun: false,
        },
        artifacts: [],
      },
    ] as never),
  );
  [{ before = 0 } = {}] = await harness.database.owner<
    { before: number }[]
  >`select max(seq)::int as before from events`;
});
test.afterAll(async () => {
  await harness?.stop();
});

const controls = (page: Page) => page.locator('article.controls');
const status = (page: Page) => page.locator('header.top .status');
/** What the tests have appended of a type, oldest first. A store of samples marks every event a sample. */
const stored = <T>(type: string) =>
  harness.database.owner<{ payload: T; actor: string }[]>`
    select payload, actor from events where type = ${type} and seq > ${before} order by seq`;
const changes = async () =>
  (await stored<{ change: { control: string; after: unknown } }>('controls.changed')).map((e) => e.payload.change);

test('a visitor sees every control read-only, and no Stop or Start', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(status(page)).toHaveText('Line running · Guarded');
  await expect(page.getByRole('button', { name: /the line/ })).toHaveCount(0);
  const panel = controls(page);
  await expect(panel.locator('.panel-head .label')).toHaveText('Read only');
  const autonomy = panel.getByRole('group', { name: 'Autonomy' });
  await expect(autonomy.getByRole('button', { name: 'Guarded' })).toHaveAttribute('aria-pressed', 'true');
  for (const button of await panel.getByRole('button').all()) await expect(button).toBeDisabled();
  await expect(panel.getByRole('switch', { name: /Agents take new work/ })).toBeChecked();
  await expect(panel.getByRole('switch', { name: /Auto-merge/ })).not.toBeChecked();
  await expect(panel.getByRole('switch', { name: /Auto-rollback/ })).toBeChecked();
  const take = panel.getByRole('group', { name: 'What the line takes' });
  await expect(take.getByRole('button', { name: 'The next few' })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toContainText('The next 5 work items from');
  await expect(panel).toContainText('Recorded: until approval routing comes, every merge waits for Martin.');
  await expect(panel.getByRole('textbox')).toHaveCount(0);
  await expect(panel.locator('.glyph.key')).toHaveCount(0);
});

test('Martin stops the line with a reason, and starts it with his passkey', async ({ page }) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');

  await test.step('Stop the line asks for a reason, and aborts the canary in flight', async () => {
    await page.getByRole('button', { name: 'Stop the line' }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop the line' });
    await expect(dialog).toContainText('make stop-the-line does the same when the console can’t.');
    const stop = dialog.getByRole('button', { name: 'Stop the line' });
    await expect(stop).toBeDisabled();
    await dialog.getByLabel('Reason').fill(REASON);
    await expect(dialog).toContainText(`${REASON.length} / 200`);
    await stop.click();
    await expect(dialog).toBeHidden();
    await expect(status(page)).toHaveText(`Line stopped · “${REASON}”`);
    expect((await stored<{ reason: string }>('line.stopped')).map((e) => e.payload.reason)).toEqual([REASON]);
    await expect.poll(() => rollout.patches.at(-1)).toEqual({ status: { abort: true } });
    expect((await stored<{ stop?: boolean }>('release.controlled')).map((e) => e.payload.stop)).toEqual([true]);
  });

  await test.step('Start the line takes its place, with the key, and runs the passkey sheet in its own dialog', async () => {
    const start = page.getByRole('button', { name: 'Start the line (asks for your passkey)' });
    await expect(page.getByRole('button', { name: 'Stop the line' })).toHaveCount(0);
    await start.click();
    const dialog = page.getByRole('dialog', { name: 'Start the line' });
    await expect(dialog).toContainText('A release stopped with the line stays stopped until you retry it.');
    await dialog.getByLabel('Reason').fill('The deploy is fine');
    await dialog.getByRole('button', { name: 'Use your passkey and start' }).click();
    await expect(dialog).toBeHidden();
    // No second dialog asked for it.
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(status(page)).toHaveText('Line running · Guarded');
    await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left');
    const started = await stored<{ reason?: string }>('line.started');
    expect(started.map((e) => [e.actor, e.payload.reason])).toEqual([['martin', 'The deploy is fine']]);
    await expect(page.getByRole('button', { name: 'Stop the line' })).toBeVisible();
  });

  await test.step('a stop the service refuses says why in the dialog', async () => {
    // Stopped from elsewhere since the page last heard: the service says so, where he pressed.
    await page.route('**/admin/line/stop', (route) =>
      route.fulfill({ status: 409, json: { refused: 'line', message: 'The line is stopped already.' } }),
    );
    await page.getByRole('button', { name: 'Stop the line' }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop the line' });
    await dialog.getByLabel('Reason').fill('Again');
    await dialog.getByRole('button', { name: 'Stop the line' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The line is stopped already.');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await page.unroute('**/admin/line/stop');
  });
});

test('Martin tightens and loosens autonomy, turns a switch, and widens and narrows the take', async ({ page }) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  const panel = controls(page);
  const autonomy = panel.getByRole('group', { name: 'Autonomy' });
  const take = panel.getByRole('group', { name: 'What the line takes' });

  await test.step('the key is drawn only where a change loosens', async () => {
    await expect(panel.locator('.panel-head .label')).toHaveCount(0);
    await expect(autonomy.getByRole('button', { name: 'Lights-out (asks for your passkey)' })).toBeVisible();
    await expect(autonomy.getByRole('button', { name: 'Supervised', exact: true })).toBeVisible();
    await expect(
      panel.getByRole('switch', { name: /Auto-merge low-risk changes \(asks for your passkey\)/ }),
    ).toBeVisible();
    await expect(take.getByRole('button', { name: 'Every ticket (asks for your passkey)' })).toBeVisible();
    await expect(take.getByRole('button', { name: 'Just one', exact: true })).toBeVisible();
    await expect(panel.getByRole('switch', { name: /Auto-rollback/ })).toBeDisabled();
  });

  await test.step('tightening autonomy acts at once', async () => {
    await autonomy.getByRole('button', { name: 'Supervised', exact: true }).click();
    await expect(autonomy.getByRole('button', { name: 'Supervised', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(status(page)).toHaveText('Line running · Supervised');
    expect(await changes()).toEqual([{ control: 'autonomy', before: 'guarded', after: 'supervised' }]);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  await test.step('loosening it asks for the passkey again', async () => {
    await autonomy.getByRole('button', { name: 'Guarded (asks for your passkey)' }).click();
    const dialog = page.getByRole('dialog', { name: 'Loosen autonomy' });
    await expect(dialog).toContainText('The line runs at Guarded.');
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(dialog).toBeHidden();
    await expect(status(page)).toHaveText('Line running · Guarded');
    expect((await changes()).at(-1)).toEqual({ control: 'autonomy', before: 'supervised', after: 'guarded' });
    // Fresh now: the keys are gone.
    await expect(panel.locator('.glyph.key')).toHaveCount(1);
    await expect(panel.locator('.legend .glyph.key')).toHaveCount(1);
  });

  await test.step('agents’ new work turns off and on, asking for nothing', async () => {
    const work = panel.getByRole('switch', { name: /Agents take new work/ });
    await work.click();
    await expect(work).not.toBeChecked();
    await work.click();
    await expect(work).toBeChecked();
    expect((await changes()).slice(-2)).toEqual([
      { control: 'new-work', before: true, after: false },
      { control: 'new-work', before: false, after: true },
    ]);
  });

  await test.step('a wider take, then a narrower one', async () => {
    await take.getByRole('button', { name: 'Every ticket' }).click();
    await expect(take.getByRole('button', { name: 'Every ticket' })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel).toContainText('The oldest open ticket of the highest severity');
    expect((await changes()).at(-1)).toMatchObject({ control: 'take', after: { kind: 'every' } });

    await take.getByRole('button', { name: 'The next few' }).click();
    await panel.getByLabel('How many').fill('2');
    await panel.getByRole('button', { name: 'Set' }).click();
    await expect(panel).toContainText('The next 2 work items from');
    await expect(panel).toContainText('0 taken so far');
    expect((await changes()).at(-1)).toMatchObject({ control: 'take', after: { kind: 'next-few', count: 2 } });
    await expect(panel.getByRole('button', { name: 'Set' })).toHaveCount(0);
  });

  await test.step('a take the service refuses says why under it', async () => {
    await take.getByRole('button', { name: 'Just one' }).click();
    await panel.getByLabel('Work item #').fill('#1329');
    await panel.getByRole('button', { name: 'Set' }).click();
    // A sample's ticket is none the line takes.
    await expect(panel.getByRole('alert')).toHaveText('#1329 has no open ticket for the line to take.');
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(take.getByRole('button', { name: 'The next few' })).toHaveAttribute('aria-pressed', 'true');
  });
});
