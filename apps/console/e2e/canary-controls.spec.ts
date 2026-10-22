/**
 * Martin's controls of the canary, end to end: the Canary panel's buttons against the real admin service on a
 * throwaway store, on one origin behind a proxy standing in for Traefik (`admin.ts`), with a virtual passkey. The
 * Rollout is a stand-in that merge-patches as Kubernetes does, at the samples' release in flight (v0.9.13 at 50%),
 * which the store records as the line would. Pausing acts at once; promoting asks for the passkey again, then the
 * header's pill counts it down and the keys are gone; aborting asks first in a dialog. Needs Postgres:
 * TEST_DATABASE_URL, or Docker.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { VERSIONS } from '@software-factory/events';
import { appendMartins } from '../../factory/src/admin/store.ts';
import type { KubeWriter } from '../../factory/src/runners/kube.ts';
import { enrolThroughTheDoor, type Harness, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_328;
const RELEASE = 'v8q7chmx72-913';

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

/** The app's Rollout as the admin service reads it, merge-patched as Kubernetes would, keeping each patch. */
class Rollout implements KubeWriter {
  version = 1;
  readonly patches: unknown[] = [];
  object: Record<string, unknown> = {
    metadata: { generation: 1, annotations: { 'rollout.argoproj.io/revision': '913' } },
    spec: {
      strategy: {
        canary: {
          steps: [
            { setWeight: 25 },
            { pause: {} },
            { analysis: {} },
            { setWeight: 50 },
            { pause: {} },
            { analysis: {} },
          ],
        },
      },
    },
    status: {
      observedGeneration: '1',
      currentPodHash: 'v8q7chmx72',
      stableRS: 'p8hwwllxzk',
      currentStepIndex: 4,
      canary: { weights: { canary: { weight: 50 } } },
    },
  };

  async get<T>(_path: string, schema: { parse(v: unknown): T }): Promise<T> {
    const { metadata, ...rest } = this.object as { metadata: object };
    return schema.parse({ ...rest, metadata: { ...metadata, resourceVersion: String(this.version) } });
  }

  async patch(_path: string, body: unknown): Promise<void> {
    const { metadata: _precondition, ...rest } = body as { metadata?: object };
    this.patches.push(rest);
    this.version += 1;
  }

  text = async () => undefined;
  create = async () => {};
  remove = async () => {};
}

let harness: Harness;
const rollout = new Rollout();

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'canary_controls', {
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
});
test.afterAll(async () => {
  await harness?.stop();
});

const panel = (page: Page) => page.locator('section.canary');
const controlled = () =>
  harness.database.owner<{ payload: { action: string } }[]>`
    select payload from events where type = 'release.controlled' order by seq`;

test('a visitor sees Martin’s controls as labels, beside what each does', async ({ page }) => {
  await page.goto('/?motion=off');
  const controls = panel(page).locator('.canary-controls');
  await expect(controls.locator('.label')).toHaveText('Martin’s controls');
  await expect(controls.locator('dt')).toHaveText(['Promote fully', 'Pause', 'Abort']);
  await expect(controls.getByRole('button')).toHaveCount(0);
  await expect(controls).toContainText('Sends all the traffic back to v0.9.12. Nothing failed, so it opens no ticket.');
});

test('Martin pauses at once, promotes with his passkey again, and aborts behind a dialog', async ({ page }) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  const controls = panel(page).locator('.canary-controls');
  await expect(controls.locator('.label')).toHaveText('Your controls');

  await test.step('Pause asks for nothing', async () => {
    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect.poll(async () => (await controlled()).map((c) => c.payload.action)).toEqual(['pause']);
    expect(rollout.patches).toEqual([{ spec: { paused: true } }]);
  });

  await test.step('Promote fully carries the key, and asks for the passkey again', async () => {
    const promote = controls.getByRole('button', { name: 'Promote fully (asks for your passkey)' });
    await expect(promote).toBeVisible();
    await expect(page.locator('.top-right .fresh')).toHaveCount(0);
    await promote.click();
    const dialog = page.getByRole('dialog', { name: 'Promote the canary' });
    await expect(dialog).toContainText('Your passkey, again');
    await expect(dialog).toContainText('v0.9.13 takes all the traffic now.');
    await expect(dialog.getByRole('heading', { name: 'Promote the canary' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Use your passkey' }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await controlled()).map((c) => c.payload.action))
      .toEqual(['pause', 'promote-fully']);
    // Fresh for five minutes: the pill counts it down, and the keys are gone.
    await expect(page.locator('.top-right .fresh')).toHaveText('Passkey given · 5min left');
    await expect(controls.getByRole('button', { name: 'Promote fully', exact: true })).toBeVisible();
  });

  await test.step('Abort asks first, and Cancel or Escape does nothing', async () => {
    await controls.getByRole('button', { name: 'Abort' }).click();
    const dialog = page.getByRole('dialog', { name: 'Abort the canary' });
    await expect(dialog).toContainText(
      'v0.9.12, the version before, takes all the traffic at once. Nothing failed, so it opens no ticket, and #1314 waits for your retry or the next deploy.',
    );
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(controls.getByRole('button', { name: 'Abort' })).toBeFocused();
    await controls.getByRole('button', { name: 'Abort' }).click();
    await dialog.getByRole('button', { name: 'Abort' }).click();
    await expect
      .poll(async () => (await controlled()).map((c) => c.payload.action))
      .toEqual(['pause', 'promote-fully', 'abort']);
  });

  await test.step('a refusal shows where he pressed', async () => {
    // The stand-in's release moved on: the service refuses, and the panel says why.
    (rollout.object.status as { currentPodHash: string }).currentPodHash = 'zzzzzzzzzz';
    await controls.getByRole('button', { name: 'Pause' }).click();
    await expect(controls.getByRole('alert')).toHaveText(
      'That release is no longer the one in the Rollout: look again.',
    );
  });
});
