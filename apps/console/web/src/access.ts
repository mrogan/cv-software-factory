/**
 * What the console keeps of the access table (`policy/access.ts`), which the admin service enforces: how long the
 * passkey given again is fresh, and which of Martin's controls ask for it, so the page draws the key where the service
 * will ask. The console's image is built without `policy/access.ts`, so it keeps these copies, and a test holds them to
 * the table.
 */
import type { ReleaseControl } from '@software-factory/events';

/** How long the passkey, given again, is fresh: `STEP_UP.minutes`. */
export const FRESH_MINUTES = 5;

/**
 * Which of Martin's controls of the canary ask for the passkey again: `release.promote` (to the next step or fully) and
 * `release.retry`, since promoting and retrying ship to more people.
 */
export const STEP_UP: Record<ReleaseControl, boolean> = {
  promote: true,
  'promote-fully': true,
  pause: false,
  resume: false,
  abort: false,
  retry: true,
};

/**
 * Which of what a save of the settings does asks for the passkey again: a dearer model or more effort
 * (`agent.raise`), and a higher cap (`caps.raise`). A save that does any of them asks.
 */
export const SETTINGS_STEP_UP = {
  'agent.raise': true,
  'agent.lower': false,
  'caps.raise': true,
  'caps.lower': false,
} as const;
