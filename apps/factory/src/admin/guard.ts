/**
 * What a request must carry to reach each of the admin service's routes, from the access table (`policy/access.ts`)
 * alone, so a route the table gives a role is held to that role, and an action the table marks needs the passkey again.
 *
 * - A visitor's read takes nothing.
 * - Martin's read takes his session.
 * - Enrolling takes the code, which its handler checks, and the console's `Origin`.
 * - Signing in takes a passkey in place of a session, which its handler checks, and the console's `Origin`.
 * - Every other write takes the console's `Origin`, his session, the session's token in a header, and, where the
 *   table marks it, the passkey given within the last five minutes.
 *
 * Every write is a `POST` (the table has no other), with a JSON body, which no form can send.
 */
import { ACCESS, type Access, type ServedBy } from '../../../../policy/access.ts';
import { same, tokenOf } from './secrets.ts';
import type { Session } from './store.ts';

export type Guard = 'none' | 'session' | 'code' | 'passkey' | 'write';

/** What each of the admin service's routes takes, from its entry in the access table. */
export function guardOf(name: ServedBy<'admin'>): Guard {
  const access: Access = ACCESS[name];
  if (access.role === 'visitor') return access.does === 'read' ? 'none' : 'write';
  if (access.role === 'enrolment code') return 'code';
  if (access.does === 'read') return 'session';
  // Signing in is the one write of Martin's that takes no session: the passkey is its credential.
  return name === 'sign-in' ? 'passkey' : 'write';
}

/** Why a request is refused, as the service says it, and its status. */
export interface Refusal {
  refused: 'origin' | 'session' | 'token' | 'step-up';
  status: 401 | 403;
  message: string;
}

/** Whether a request's `Origin` is exactly the console's. */
export const fromConsole = (origin: string | undefined, consoleOrigin: string) => origin === consoleOrigin;

/**
 * Whether a write may go ahead: the console's origin, a live session, its token, and the passkey given again if the
 * table marks the action. Undefined if it may; the refusal if not. `session` is the live session the cookie names, if
 * any, and `id` the cookie's value.
 */
export function refuseWrite(
  access: Access,
  given: { origin: string | undefined; token: string | undefined; id: string | undefined },
  session: Session | undefined,
  consoleOrigin: string,
): Refusal | undefined {
  if (!fromConsole(given.origin, consoleOrigin)) {
    return { refused: 'origin', status: 403, message: "Only the console's own pages may ask for this." };
  }
  if (!session || !given.id) {
    return { refused: 'session', status: 401, message: 'Sign in first: there is no session, or it has ended.' };
  }
  if (!given.token || !same(given.token, tokenOf(given.id))) {
    return { refused: 'token', status: 403, message: "The request does not carry this session's token." };
  }
  if (access.stepUp && !session.steppedUp) {
    return { refused: 'step-up', status: 403, message: 'This needs your passkey again.' };
  }
  return undefined;
}
