/**
 * A canary paused for Martin, end to end: with auto-rollback off, the analysis judged the samples' release in flight
 * (v0.9.13 at 50%) bad at its step, as the line records it, and the Rollout stand-in is paused on it
 * (`InconclusiveAnalysisRun`), against the real admin service on a throwaway store, on one origin behind a proxy standing
 * in for Traefik (`admin.ts`), with a virtual passkey. The panel says so and offers only Promote fully and Abort; Needs
 * you has the one card for it, whose Abort is the panel's, behind the dialog that says it counts as a rollback. A
 * visitor reads the same, read only. Snapshots are `visual.spec.ts`'s. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { VERSIONS } from '@software-factory/events';
import { appendMartins } from '../../factory/src/admin/store.ts';
import { enrolThroughTheDoor, type Harness, Rollout, startHarness, virtualPasskey } from './admin.ts';
import { expect, test } from './support.ts';

const PORT = 18_338;
const RELEASE = 'v8q7chmx72-913';
const SAID = 'Metric "errors" assessed Inconclusive due to inconclusive (1) > inconclusiveLimit (0)';

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let harness: Harness;
const rollout = new Rollout();

test.beforeAll(async () => {
  harness = await startHarness(PORT, 'canary_paused', {
    rollout: { namespace: 'website', name: 'website' },
    kube: rollout,
  });
  // Argo Rollouts paused it on the step's run, which ended Inconclusive.
  Object.assign(rollout.object.status as object, {
    controllerPause: true,
    pauseConditions: [{ reason: 'InconclusiveAnalysisRun', startTime: new Date().toISOString() }],
  });
  const event = (type: 'release.started' | 'canary.stepped', payload: unknown) => ({
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: null,
    type,
    version: VERSIONS[type],
    actor: 'rollouts',
    summary: type,
    payload,
    artifacts: [],
  });
  // The line's record of the release in flight, as the samples have it, and of its step the analysis judged bad.
  const line = harness.database.as.line;
  await line.begin((tx) =>
    appendMartins(line, tx, [
      event('release.started', {
        release: RELEASE,
        version: 'v0.9.13',
        previous: 'v0.9.12',
        image: { digest: `sha256:${'6'.repeat(64)}`, signed: true, admitted: true },
        watched: true,
        steps: null,
        dryRun: false,
      }),
      event('canary.stepped', {
        release: RELEASE,
        version: 'v0.9.13',
        weight: 50,
        analysis: {
          phase: 'inconclusive',
          requests: 846,
          measures: [{ name: 'errors', phase: 'inconclusive', value: 0.0253, limit: 0.01, message: SAID }],
        },
        figures: {
          canary: { requests: 846, errorRate: 0.0392, p99Ms: 42, journeys: null },
          baseline: { requests: 902, errorRate: 0.0139, p99Ms: 39, journeys: null },
        },
        dryRun: false,
      }),
    ] as never),
  );
});
test.afterAll(async () => {
  await harness?.stop();
});

const panel = (page: Page) => page.locator('section.canary');
const paused = (page: Page) =>
  page.locator('article.needs .need').filter({ has: page.getByText('A canary paused for you') });
const controlled = () =>
  harness.database.owner<{ payload: { action: string } }[]>`
    select payload from events where type = 'release.controlled' order by seq`;

test('a visitor reads the canary paused for Martin, and its card, read only', async ({ page }) => {
  await page.goto('/?motion=off');
  await expect(panel(page).locator('.kick')).toHaveText('Paused for Martin at 50% · judged bad');
  await expect(panel(page).locator('.canary-note')).toContainText(
    '5xx share 3.92% against 1.39%: 2.53 points above, at most 1.00 points allowed. Auto-rollback was off, so that is inconclusive rather than failed, and Argo Rollouts has paused it for Martin.',
  );
  await expect(panel(page).getByRole('row', { name: /^Errors / })).toContainText('inconclusive · waits for Martin');
  await expect(panel(page).locator('.words')).toHaveText(SAID);
  await expect(panel(page).locator('.canary-controls dt')).toHaveText(['Promote fully', 'Abort']);
  const card = paused(page);
  await expect(card).toHaveCount(1);
  await expect(card.locator('.kick span')).toHaveText(/^#1314 · Release · 50% · /);
  await expect(card.getByRole('button')).toHaveCount(1);
  await expect(card.getByRole('button')).toHaveText('Open the work item');
  await expect(card.locator('.ro')).toHaveText(['Promote fully', 'Abort']);
  await expect(card).toContainText('Martin answers, signed in');
});

test('Martin sees only Promote fully, with the key, and Abort, which counts as a rollback, in the card and the panel', async ({
  page,
}) => {
  await virtualPasskey(page);
  await enrolThroughTheDoor(page, await harness.code());
  await page.goto('/?motion=off');
  const controls = panel(page).locator('.canary-controls');
  await expect(controls.getByRole('button')).toHaveText(['Promote fully (asks for your passkey)', 'Abort']);
  const card = paused(page);
  await expect(card.getByRole('button', { name: 'Promote fully (asks for your passkey)' })).toBeVisible();
  await expect(card).toContainText(
    'Sends all the traffic back to v0.9.12. It counts as a rollback: #1314 fails Release, and triage gets the analysis’s verdict.',
  );

  await test.step('Abort from the card asks first, saying it counts as a rollback', async () => {
    await card.getByRole('button', { name: 'Abort' }).click();
    const dialog = page.getByRole('dialog', { name: 'Abort the canary' });
    await expect(dialog).toContainText(
      'v0.9.12, the version before, takes all the traffic at once. It counts as a rollback, since the analysis judged it bad: triage gets its verdict, as from any rollback, and #1314 fails Release.',
    );
    await dialog.getByRole('button', { name: 'Abort' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await controlled()).map((c) => c.payload.action)).toEqual(['abort']);
    expect(rollout.patches.at(-1)).toEqual({ status: { abort: true } });
  });

  await test.step('the abort shows at once, in the card and the panel, before the line records the rollback', async () => {
    await expect(panel(page).locator('.kick .out')).toHaveText('Aborting at 50%…');
    await expect(controls.getByRole('button')).toHaveCount(0);
    await expect(card.locator('.answers')).toHaveCount(0);
    await expect(card.getByRole('status')).toHaveText(
      /^You aborted the canary at 50%, at \d\d:\d\d:\d\d: Argo Rollouts sends all the traffic back to v0\.9\.12\. Since the analysis judged it bad, it counts as a rollback\. The line records it at its next pass\.$/,
    );
  });
});
