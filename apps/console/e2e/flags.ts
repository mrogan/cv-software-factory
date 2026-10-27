/**
 * The flags' states the browser tests share (`flags.spec.ts`, `quality.spec.ts`, `visual.spec.ts`): moments in the
 * samples, Martin's moves after their end, and the admin service's check of the app in each of its states.
 */
import type { Page } from '@playwright/test';
import type { RawEvent } from '@software-factory/events';
import { END } from './support.ts';

/** last-one at Checks, before Martin widened it to Preview: from there, Share may be taken at once. */
export const AT_CHECKS = Date.parse('2026-10-01T10:00:00Z');
/** delivery-dates released with its flag off, before Martin widened it to Checks. */
export const RELEASED_OFF = Date.parse('2026-10-03T08:30:00Z');
/** last-one at Share, while Verify compares its two sides. */
export const COMPARING = Date.parse('2026-10-01T12:00:00Z');

/** Martin's moves after the samples' end, as the admin service records them: last-one off, delivery-dates off too. */
export const TURNED_OFF = [
  {
    id: '00000000-0000-4000-8000-000000000901',
    seq: 901,
    ts: new Date(END - 20 * 60_000).toISOString(),
    work_item: '1271',
    type: 'flag.staged',
    version: 1,
    actor: 'martin',
    summary: 'Martin turned last-one off, from Everyone',
    payload: {
      flag: 'last-one',
      from: { stage: 'everyone' },
      to: { stage: 'off' },
      action: 'flag.off',
      revision: 'r7',
      reason: 'It says the last one when there are two',
      steppedUp: false,
    },
    artifacts: [],
  },
  {
    id: '00000000-0000-4000-8000-000000000902',
    seq: 902,
    ts: new Date(END - 10 * 60_000).toISOString(),
    work_item: '1294',
    type: 'flag.staged',
    version: 1,
    actor: 'martin',
    summary: 'Martin turned delivery-dates off, from Preview',
    payload: {
      flag: 'delivery-dates',
      from: { stage: 'preview' },
      to: { stage: 'off' },
      action: 'flag.off',
      revision: 'r8',
      reason: 'The date is wrong on Sundays',
      steppedUp: false,
    },
    artifacts: [],
  },
  {
    id: '00000000-0000-4000-8000-000000000903',
    seq: 903,
    ts: new Date(END - 9 * 60_000).toISOString(),
    work_item: '1294',
    type: 'work-item.closed',
    version: 1,
    actor: 'factory',
    summary: 'Closed: turned off',
    payload: { outcome: 'no-change', reason: 'Martin turned its flag off' },
    artifacts: [],
  },
] as unknown as RawEvent[];

/** What the admin service's check of the app says, by state. */
export const HELD = {
  held: { state: 'held', revision: 'r6', held: ['r6'], since: null, checkedAt: new Date(END - 40_000).toISOString() },
  taking: {
    state: 'taking',
    revision: 'r7',
    held: ['r6'],
    since: new Date(END - 20_000).toISOString(),
    checkedAt: new Date(END - 10_000).toISOString(),
  },
  lagging: {
    state: 'lagging',
    revision: 'r7',
    held: ['r6', 'r7'],
    since: new Date(END - 180_000).toISOString(),
    checkedAt: new Date(END - 10_000).toISOString(),
  },
  unchecked: {
    state: 'unchecked',
    revision: 'r6',
    held: [],
    since: null,
    checkedAt: new Date(END - 30_000).toISOString(),
  },
} as const;

/** Answers the admin service's read of whether the app holds the flags, with this state. */
export async function heldAs(page: Page, state: keyof typeof HELD | 'off'): Promise<void> {
  await page.route('**/admin/flags/held', (route) =>
    state === 'off'
      ? route.fulfill({
          status: 503,
          json: { refused: 'flags', message: 'The admin service does not check the flags.' },
        })
      : route.fulfill({ json: HELD[state] }),
  );
}
