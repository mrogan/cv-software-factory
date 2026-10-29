/**
 * Whether alerts reach Martin's phone, as the line reads it from the store: his latest `alerts.switched`, or the
 * profile's default (`policy/phone.ts`). The admin service reports the same (`admin/phone.ts`), and `PhoneOff`, which
 * mutes every alert with a level, fires only while both say off: the admin service, which appends the switch, cannot
 * keep alerts from Martin by reporting it off alone, as the line reads only what his roles stored, and a compromised
 * admin service can neither reach the line nor change an event once stored.
 *
 * Read each time the SDK collects. A read that fails observes nothing new, and the SDK sends the last it had; a line
 * that never read it reports nothing, and with nothing, nothing is muted.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import { latestPhone } from '@software-factory/store';
import type { Sql } from 'postgres';
import { phoneInForce } from '../../../../policy/phone.ts';
import type { Profile } from '../../../../policy/spend.ts';
import type { Logger } from '../log.ts';

const meter = metrics.getMeter('factory-line');

const phone = meter.createObservableGauge('line.alerts.phone', {
  description:
    "Whether alerts reach Martin's phone, as the line reads his switch or the profile's default: 1 if so, 0 if not",
});

/** Reports the switch in force each time the SDK collects, until the function it gives back is called. */
export function observePhone(sql: Sql, profile: Profile, log: Logger): () => void {
  let failing = false;
  const callback = async (result: BatchObservableResult) => {
    let on: boolean;
    try {
      on = phoneInForce(profile, await latestPhone(sql));
    } catch (error) {
      if (!failing) log.warn({ err: error }, 'could not read whether alerts reach the phone: reporting nothing new');
      failing = true;
      return;
    }
    if (failing) log.info('reading whether alerts reach the phone again');
    failing = false;
    result.observe(phone, on ? 1 : 0);
  };
  meter.addBatchObservableCallback(callback, [phone]);
  return () => meter.removeBatchObservableCallback(callback, [phone]);
}
