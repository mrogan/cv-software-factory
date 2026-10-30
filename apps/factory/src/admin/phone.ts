/**
 * Whether alerts reach Martin's phone: every alert at its level, or none (`policy/phone.ts`), switched from the
 * console's Controls (`POST /admin/alerts/phone`), and told to Prometheus.
 *
 * - **A switch** is one `alerts.switched` event, the switch as it now stands. Off loosens what reaches him, so it needs
 *   the passkey again (`phone.off` in the access table), asked after the lock every append takes, as the passkey given
 *   may have gone stale while it waited. A switch to what is already in force records nothing.
 * - **The series** (`admin.alerts.phone`, 1 on, 0 off) is read from the store each time the SDK collects, so a switch
 *   reaches Prometheus at its next export, and a second replica says the same. While it reads 0, and the line's own
 *   read of the switch (`line/phone.ts`) does too, the `PhoneOff` rule fires, and Alertmanager mutes every alert with a
 *   level (deploy/base/telemetry/values/prometheus.yaml): this service's word alone mutes nothing. With no series in the
 *   last minute, from an admin service that is down, not yet scraped, or started without the store, nothing is muted:
 *   alerts reach the phone, which is failing loud. A read that fails once it has read one observes nothing new, and
 *   the SDK sends the last switch it read again: only Martin changes it, and only through this service.
 *
 * The line counts each switch as a security event (`line/security.ts`), from the stored event alone: switching off
 * pages him, past the mute, so on the cloud the last message before quiet says so.
 */
import { latestPhone, lockAppends } from '@software-factory/store';
import { z } from 'zod';
import { ACCESS } from '../../../../policy/access.ts';
import { phoneAction, phoneInForce } from '../../../../policy/phone.ts';
import type { Profile } from '../../../../policy/spend.ts';
import { phoneGauge } from '../phone.ts';
import { type AdminStore, adminEvent, Refused, type Session, steppedUpNow } from './store.ts';

/** A switch, as Controls sends it. */
export const SWITCH = z.strictObject({ phone: z.boolean() });
export type Switch = z.infer<typeof SWITCH>;

/** The summary of a switch, in the console's words. */
export const switchSummary = (phone: boolean) =>
  phone ? 'Martin sent every alert to his phone' : 'Martin stopped alerts reaching his phone';

/** Switches alerts to the phone, or refuses having changed nothing: whether they reach it now, and whether that changed. */
export async function switchPhone(
  store: AdminStore,
  profile: Profile,
  session: Session,
  asked: Switch,
): Promise<{ phone: boolean; changed: boolean }> {
  const changed = await store.record(
    async (tx) => {
      await lockAppends(tx);
      if (phoneInForce(profile, await latestPhone(tx)) === asked.phone) return false;
      if (ACCESS[phoneAction(asked.phone)].stepUp && !(await steppedUpNow(tx, session))) {
        throw new Refused('step-up', 403, 'This needs your passkey again.');
      }
      return true;
    },
    (changed) => (changed ? [adminEvent('alerts.switched', switchSummary(asked.phone), { phone: asked.phone })] : []),
  );
  return { phone: asked.phone, changed };
}

/** Reports the switch in force, read from the store, each time the SDK collects (`../phone.ts`). */
export const observePhone = phoneGauge(
  'factory-admin',
  'admin.alerts.phone',
  "Whether alerts reach Martin's phone, as he switched it or the profile's default: 1 if so, 0 if not",
);
