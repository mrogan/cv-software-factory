/**
 * Stopping and starting the line from the console's header, each with Martin's reason, for the audit log.
 *
 * - **Stop the line** (`POST /admin/line/stop`) appends `line.stopped`, the same event as `make stop-the-line`, which
 *   every worker heeds: each agent stops at the end of its step, and nothing new is taken. Then it aborts the canary in
 *   flight, if there is one, through the admin service's own Role on the app's Rollout (`rollout.ts`), as
 *   `scripts/abort-canaries.sh` does with Martin's credentials. The stop is appended first, so the agents stop even if
 *   Kubernetes cannot be reached; if the abort fails, the line stays stopped, and the answer says that the canary was
 *   not aborted and that `make stop-the-line` will abort it. It never asks for the passkey again: it tightens.
 * - **Start the line** (`POST /admin/line/start`) appends `line.started`, and needs the passkey again (`line.start` in
 *   the access table). A release stopped with the line stays stopped until Martin retries it from the Canary panel.
 *
 * Each is refused, having appended nothing, when the line is already as asked: stopped, or running. They are taken one
 * at a time, under the lock every append takes, so two presses cannot both stop or both start it.
 *
 * `make stop-the-line` keeps its own path, which needs neither the console nor the admin service.
 */
import { lineStopped } from '@software-factory/store';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ReleaseControls } from './rollout.ts';
import { type AdminStore, adminEvent, Refused, type Session, steppedUpNow } from './store.ts';

/** Martin's reason, for the audit log: visitors see it, with anything shaped like a secret left out. */
export const REASON = z.strictObject({ reason: z.string().trim().min(1).max(200) });

/** What stopping the line did: the line is stopped, and the canary in flight was aborted, or there was none, or not. */
export interface Stopped {
  stopped: true;
  canary: 'aborted' | 'none' | 'not-aborted';
  /** The release aborted. */
  release?: string;
  /** What Martin must know: the canary was not aborted, or his pause of it is still set. */
  warning?: string;
}

/** What the answer says when the canary in flight could not be aborted. */
export const NOT_ABORTED =
  'The line is stopped, but a canary in flight was not aborted: the admin service could not read or patch the ' +
  'Rollout. Run `make stop-the-line`, which will abort it.';

/** What the answer says when the admin service has no Rollout to control. */
export const NO_ROLLOUT =
  'The line is stopped. The admin service controls no Rollout, so it aborted no canary: if one is in flight, ' +
  '`make stop-the-line` will abort it.';

/** Takes the lock every append takes, so the line's state read is the one the event follows. */
const lock = (tx: Parameters<Parameters<AdminStore['record']>[0]>[0]) =>
  tx`select pg_advisory_xact_lock(hashtext('events'))`;

/** Stops the line with Martin's reason, then aborts the canary in flight; or refuses a line already stopped. */
export async function stopLine(
  store: AdminStore,
  controls: ReleaseControls | undefined,
  log: Logger,
  reason: string,
): Promise<Stopped> {
  await store.record(
    async (tx) => {
      await lock(tx);
      if (await lineStopped(tx)) throw new Refused('line', 409, 'The line is stopped already.');
    },
    () => [adminEvent('line.stopped', 'Martin stopped the line', { reason })],
  );
  if (!controls) return { stopped: true, canary: 'not-aborted', warning: NO_ROLLOUT };
  try {
    const abort = await controls.stop();
    if (abort.canary === 'none') return { stopped: true, canary: 'none' };
    return {
      stopped: true,
      canary: 'aborted',
      release: abort.release,
      ...(abort.warning && { warning: abort.warning }),
    };
  } catch (error) {
    // With no Rollout of the app, there is no canary to abort.
    if (error instanceof Refused && error.refused === 'rollout') return { stopped: true, canary: 'none' };
    log.error({ err: error }, 'the line stopped, and the canary in flight could not be aborted');
    return { stopped: true, canary: 'not-aborted', warning: NOT_ABORTED };
  }
}

/** Starts the line with Martin's reason, the passkey given again; or refuses a line already running. */
export async function startLine(store: AdminStore, session: Session, reason: string): Promise<{ started: true }> {
  await store.record(
    async (tx) => {
      await lock(tx);
      if (!(await lineStopped(tx))) throw new Refused('line', 409, 'The line is running already.');
      // Asked again as the start is taken, after the lock: the passkey given may have gone stale while it waited.
      if (!(await steppedUpNow(tx, session))) throw new Refused('step-up', 403, 'This needs your passkey again.');
    },
    () => [adminEvent('line.started', 'Martin started the line', { reason })],
  );
  return { started: true };
}
