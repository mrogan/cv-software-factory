/**
 * Whether alerts reach Martin's phone, as the line reads it from the store: his latest `alerts.switched`, or the
 * profile's default (`policy/phone.ts`). The admin service reports the same (`admin/phone.ts`), and `PhoneOff`, which
 * mutes every alert with a level, fires only while both say off: the admin service, which appends the switch, cannot
 * keep alerts from Martin by reporting it off alone, as the line reads only what his roles stored, and a compromised
 * admin service can neither reach the line nor change an event once stored. One that appends a switch off in his name
 * mutes them, as his own would, and pages him as it does: the line counts it as `phone-off`, which the mute lets
 * through.
 */
import { phoneGauge } from '../phone.ts';

/** Reports the switch in force, as the line reads it, each time the SDK collects (`../phone.ts`). */
export const observePhone = phoneGauge(
  'factory-line',
  'line.alerts.phone',
  "Whether alerts reach Martin's phone, as the line reads his switch or the profile's default: 1 if so, 0 if not",
);
