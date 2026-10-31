/**
 * Whether auto-rollback is on, as a gauge a worker reports: Martin's latest `controls.changed` read from the store, or
 * policy's default, on (`policy/line.ts`), 1 if on, 0 if off. The admin service and the line each report one
 * (`admin/auto-rollback.ts`, `line/auto-rollback.ts`), and the canary's analysis calls a bad verdict inconclusive, so
 * that Argo Rollouts pauses the canary for Martin rather than rolling it back, only while there is exactly one series
 * from each and both read 0 (`release/analysis.ts`). So the two read it the same way, here.
 *
 * Read each time the SDK collects. A read that fails observes nothing new, and says so once in the log until one
 * succeeds again; a worker that never read it reports nothing, and with nothing, a bad canary rolls back.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import { latestControls } from '@software-factory/store';
import type { Sql } from 'postgres';
import { controlsInForce } from '../../../policy/line.ts';
import type { Logger } from './log.ts';

/** A worker's gauge of auto-rollback: its meter's name, and the gauge's. */
export function autoRollbackGauge(meterName: string, name: string, description: string) {
  const meter = metrics.getMeter(meterName);
  const gauge = meter.createObservableGauge(name, { description });
  /** Reports auto-rollback as in force each time the SDK collects, until the function it gives back is called. */
  return (sql: Sql, log: Logger): (() => void) => {
    let failing = false;
    const callback = async (result: BatchObservableResult) => {
      let on: boolean;
      try {
        on = controlsInForce(await latestControls(sql)).autoRollback;
      } catch (error) {
        if (!failing) log.warn({ err: error }, 'could not read whether auto-rollback is on: reporting nothing new');
        failing = true;
        return;
      }
      if (failing) log.info('reading whether auto-rollback is on again');
      failing = false;
      result.observe(gauge, on ? 1 : 0);
    };
    meter.addBatchObservableCallback(callback, [gauge]);
    return () => meter.removeBatchObservableCallback(callback, [gauge]);
  };
}
