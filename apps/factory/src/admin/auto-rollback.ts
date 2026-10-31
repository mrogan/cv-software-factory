/**
 * Whether auto-rollback is on, as the admin service reads it from the store: Martin's latest `controls.changed`, or
 * policy's default, on. The admin service appends the switch (`POST /admin/line/controls`, `line.ts`), and is the
 * service the internet reaches, so its word alone turns nothing off: the canary's analysis takes a bad verdict as
 * inconclusive only while the line, which reads only what Martin's roles stored, says off too (`release/analysis.ts`).
 */
import { autoRollbackGauge } from '../auto-rollback.ts';

/** Reports auto-rollback as in force, read from the store, each time the SDK collects (`../auto-rollback.ts`). */
export const observeAutoRollback = autoRollbackGauge(
  'factory-admin',
  'admin.auto_rollback',
  'Whether a canary the analysis judges bad rolls back by itself, as Martin switched it or policy’s default: 1 if so, 0 if it pauses for him',
);
