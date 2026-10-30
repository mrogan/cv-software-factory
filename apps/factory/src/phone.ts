/**
 * Whether alerts reach Martin's phone, as a gauge a worker reports: his latest `alerts.switched` read from the store,
 * or the profile's default (`policy/phone.ts`), 1 if so, 0 if not. The admin service and the line each report one
 * (`admin/phone.ts`, `line/phone.ts`), and `PhoneOff` mutes alerts only while both say off, so the two read it the
 * same way, here.
 *
 * Read each time the SDK collects. A read that fails observes nothing new, and says so once in the log until one
 * succeeds again; a worker that never read it reports nothing, and with nothing, nothing is muted.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import { latestPhone } from '@software-factory/store';
import type { Sql } from 'postgres';
import { phoneInForce } from '../../../policy/phone.ts';
import type { Profile } from '../../../policy/spend.ts';
import type { Logger } from './log.ts';

/** A worker's gauge of the switch: its meter's name, and the gauge's. */
export function phoneGauge(meterName: string, name: string, description: string) {
  const meter = metrics.getMeter(meterName);
  const phone = meter.createObservableGauge(name, { description });
  /** Reports the switch in force each time the SDK collects, until the function it gives back is called. */
  return (sql: Sql, profile: Profile, log: Logger): (() => void) => {
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
  };
}
