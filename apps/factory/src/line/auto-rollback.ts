/**
 * Whether auto-rollback is on, as the line reads it from the store: Martin's latest `controls.changed`, or policy's
 * default, on. The admin service reports the same (`admin/auto-rollback.ts`), and the canary's analysis takes a bad
 * verdict as inconclusive, pausing the canary for Martin, only while both say off (`release/analysis.ts`): the admin
 * service, which appends the switch, cannot keep a bad canary from rolling back by reporting it off alone, as the line
 * reads only what his roles stored, and a compromised admin service can neither reach the line nor change an event
 * once stored. One that appends a switch off in his name turns it off, as his own would, and pages him as it does: the
 * line counts it as `auto-rollback-off`.
 */
import { autoRollbackGauge } from '../auto-rollback.ts';

/** Reports auto-rollback as in force, as the line reads it, each time the SDK collects (`../auto-rollback.ts`). */
export const observeAutoRollback = autoRollbackGauge(
  'factory-line',
  'line.auto_rollback',
  'Whether a canary the analysis judges bad rolls back by itself, as the line reads Martin’s switch or policy’s default: 1 if so, 0 if it pauses for him',
);
