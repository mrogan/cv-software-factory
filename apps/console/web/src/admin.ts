/**
 * Martin's side of the console: whether this browser holds his session, and the admin service's routes it calls. The
 * console's own server never sees the session: the admin service answers `/admin/` on the same origin, and the cookie
 * that names the session is `HttpOnly`, so this code never reads it either. It asks the service, and believes the answer.
 *
 * Every write carries the session's token in `X-CSRF-Token`, as JSON, which no form on another site can send; the
 * browser adds `Origin`, which the service matches against the console's own.
 */
import { useEffect, useState } from 'react';

/** The admin service's description of a live session (`GET /admin/session`). */
export interface Session {
  signedInAt: string;
  expiresAt: string;
  steppedUpAt: string | null;
  steppedUp: boolean;
  /** What every write in this session carries in `X-CSRF-Token`. */
  token: string;
  passkey: { id: string; name: string };
  passkeys: { id: string; name: string; enrolledAt: string; lastUsedAt: string | null; current: boolean }[];
}

/**
 * Who is looking:
 * - `checking`: the admin service has not answered yet;
 * - `none`: there is no admin service to ask (the replay site, development without one, a cluster before its
 *   Deployment), so there is nothing to sign in to;
 * - `visitor`: the service is there, and this browser holds no session;
 * - `martin`: signed in.
 */
export type Admin =
  | { kind: 'checking' }
  | { kind: 'none' }
  | { kind: 'visitor' }
  | { kind: 'martin'; session: Session };

/** An answer from the admin service: its status, and its JSON, or nothing when it sent none. */
export interface Answer {
  status: number;
  body: Record<string, unknown> | undefined;
}

async function answer(res: Response): Promise<Answer> {
  // The service answers JSON alone; anything else (a proxy's page, development's fallback) is not it.
  const json = (res.headers.get('content-type') ?? '').startsWith('application/json');
  const body = json ? ((await res.json().catch(() => undefined)) as Record<string, unknown> | undefined) : undefined;
  return { status: res.status, body };
}

/** Asks the admin service whether this browser is signed in. */
export async function check(): Promise<Admin> {
  try {
    const got = await answer(await fetch('/admin/session', { cache: 'no-store', credentials: 'same-origin' }));
    if (got.status === 200 && typeof got.body?.token === 'string') {
      return { kind: 'martin', session: got.body as unknown as Session };
    }
    // The service refuses with a reason of its own; no reason means something else answered.
    if (got.status === 401 && got.body?.refused === 'session') return { kind: 'visitor' };
    return { kind: 'none' };
  } catch {
    return { kind: 'none' };
  }
}

/** A write to the admin service: a `POST` of JSON, with the session's token when there is one. */
export async function post(path: string, body: object = {}, token?: string): Promise<Answer> {
  try {
    return await answer(
      await fetch(path, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...(token && { 'x-csrf-token': token }) },
        body: JSON.stringify(body),
      }),
    );
  } catch {
    return { status: 0, body: undefined };
  }
}

/** The service's own words for a refusal, or ours when it gave none (it was unreachable, or something else answered). */
export const said = (got: Answer): string =>
  typeof got.body?.message === 'string'
    ? got.body.message
    : got.status === 0
      ? 'The admin service can’t be reached. Try again in a moment.'
      : 'Something failed on the way to the admin service. Try again in a moment.';

/** Where a door is: `?view=sign-in` or `?view=enrol` on the console's own page. */
export type Door = 'sign-in' | 'enrol';

/** Why the sign-in page was opened, shown above its button: a session that ended, here, everywhere or by its hours. */
export type Ended = 'here' | 'everywhere' | 'expired';

export const doorHref = (door: Door, ended?: Ended, at?: string) => {
  const params = new URLSearchParams({ view: door });
  if (ended) params.set('ended', ended);
  if (at) params.set('at', at);
  return `/?${params}`;
};

/**
 * Whether this browser is signed in, asked as the page opens, and again when the session's eight hours are up or the
 * page is shown again: a session that has ended sends the page to the sign-in door, saying so. Only the live console asks: a recording has no service.
 */
export function useAdmin(live: boolean): Admin {
  const [admin, setAdmin] = useState<Admin>(() => (live ? { kind: 'checking' } : { kind: 'none' }));
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void check().then((found) => {
      if (!cancelled) setAdmin(found);
    });
    return () => {
      cancelled = true;
    };
  }, [live]);

  const expiresAt = admin.kind === 'martin' ? admin.session.expiresAt : undefined;
  useEffect(() => {
    if (!expiresAt) return;
    const ends = Date.parse(expiresAt);
    // Asked again rather than assumed, so a clock that is out says nothing wrong.
    const ended = () =>
      void check().then((found) => {
        // Gone, not unreachable: a service that cannot be asked leaves the page as it is.
        if (found.kind !== 'visitor') return;
        location.assign(Date.now() >= ends ? doorHref('sign-in', 'expired', expiresAt) : doorHref('sign-in', 'here'));
      });
    // A timer sleeps with the laptop, so coming back to the page asks again too: the session may also have ended
    // early, signed out everywhere from another device or its passkey revoked.
    const timer = setTimeout(ended, Math.max(0, ends - Date.now()) + 1000);
    const back = () => {
      if (document.visibilityState === 'visible') ended();
    };
    document.addEventListener('visibilitychange', back);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', back);
    };
  }, [expiresAt]);

  return admin;
}
