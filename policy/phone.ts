/**
 * Whether alerts reach Martin's phone: every alert at its level, or none, as he switched it in the console
 * (`alerts.switched`). This is the one check: the admin service, which tells Prometheus, and the console's Controls each
 * turn the latest switch into the one in force with `phoneInForce`, so both agree.
 *
 * Before he switches it, the profile's default is in force: on for the cloud profiles, where the factory runs for
 * others to see and he must hear of it; off on the laptop, where alerts exist only to be tried before the cloud, and he
 * reads them on Grafana's Alerts dashboard. Whatever an event says, anything but a yes or no is not in force, and the
 * profile's default is.
 *
 * Switching them off loosens what reaches him, so it needs the passkey again (`phone.off` in `access.ts`), and pages him
 * as it does. Switching them on tightens, and informs him.
 *
 * Human-owned: see `README.md`.
 */
import type { Profile } from './spend.ts';

/** Whether alerts reach the phone on each profile before Martin switches them. */
export const PHONE_DEFAULT: Record<Profile, boolean> = { local: false, do: true, aws: true };

/** The access table's action a switch is: on, or off. */
export type PhoneAction = 'phone.on' | 'phone.off';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether alerts reach the phone, from the latest switch's payload (or none), on a profile. */
export function phoneInForce(profile: Profile, chosen?: unknown): boolean {
  return isRecord(chosen) && typeof chosen.phone === 'boolean' ? chosen.phone : PHONE_DEFAULT[profile];
}

/** Which action switching the phone to `on` is. */
export const phoneAction = (on: boolean): PhoneAction => (on ? 'phone.on' : 'phone.off');
