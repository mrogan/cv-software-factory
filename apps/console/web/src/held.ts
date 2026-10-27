/**
 * Whether the app holds the flags as set, as the admin service last checked: its public read, which anyone may make as
 * often as they like, and which never asks the app itself. Plain TypeScript, so Node tests it.
 */

const isString = (value: unknown): value is string => typeof value === 'string';
const isTime = (value: unknown): value is string => isString(value) && !Number.isNaN(Date.parse(value));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/**
 * Whether the app holds the flags as set, as the admin service last checked (`GET /admin/flags/held`, public): `held`
 * by every pod, `taking` a change within a minute of it, `lagging` behind it, or `unchecked` when the last check could
 * not ask every pod. The revision `flags` holds, what the pods answered, since when it has differed, and when it was
 * last asked.
 */
export interface Held {
  state: 'held' | 'taking' | 'lagging' | 'unchecked';
  revision: string | null;
  held: string[];
  since: string | null;
  checkedAt: string | null;
}

/** What the read said: the check, that the service checks nothing here (503), or nothing to show (no answer). */
export type HeldAnswer = { kind: 'held'; held: Held } | { kind: 'off' } | { kind: 'unknown' };

const HELD_STATES: readonly string[] = ['held', 'taking', 'lagging', 'unchecked'];
const orNull = (value: unknown, is: (value: unknown) => boolean) => value === null || is(value);

/** Whether an answer is the whole of the read, every field the page draws in place. */
export const isHeld = (body: unknown): body is Held =>
  isRecord(body) &&
  typeof body.state === 'string' &&
  HELD_STATES.includes(body.state) &&
  orNull(body.revision, isString) &&
  Array.isArray(body.held) &&
  body.held.every(isString) &&
  orNull(body.since, isTime) &&
  orNull(body.checkedAt, isTime);

/** Asks the admin service whether the app holds the flags as set. It never asks the app: it says the last check. */
export async function heldFlags(): Promise<HeldAnswer> {
  try {
    const res = await fetch('/admin/flags/held', { cache: 'no-store', credentials: 'same-origin' });
    // The service answers JSON alone; anything else (a proxy's page, development's fallback) is not it.
    if (!(res.headers.get('content-type') ?? '').startsWith('application/json')) return { kind: 'unknown' };
    const body: unknown = await res.json().catch(() => undefined);
    if (res.status === 200 && isHeld(body)) return { kind: 'held', held: body };
    if (res.status === 503 && isRecord(body) && body.refused === 'flags') return { kind: 'off' };
    return { kind: 'unknown' };
  } catch {
    return { kind: 'unknown' };
  }
}
