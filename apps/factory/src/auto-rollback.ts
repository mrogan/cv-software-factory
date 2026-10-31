/**
 * Whether auto-rollback is on, as a gauge a worker reports: Martin's latest `controls.changed` read from the store, or
 * policy's default, on (`policy/line.ts`), 1 if on, 0 if off. The admin service and the line each report one (their
 * own `auto-rollback.ts`), and the canary's analysis calls a bad verdict inconclusive, so that Argo Rollouts pauses the
 * canary for Martin rather than rolling it back, only while there is exactly one series from each and both read 0 (the
 * release's `analysis.ts`). So the two read it the same way, here. Each is named here without its folder: the browser
 * tests' check of what they reach reads a path from here as a file this starts.
 *
 * Read each time the SDK collects. A read that fails reports on, and says so once in the log until one succeeds again:
 * the SDK would otherwise go on sending the last figure it had, so a worker that read off once, then lost the store,
 * would keep a bad canary from rolling back on a word nobody can confirm. Off is believed only while it is read.
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
        if (!failing) log.warn({ err: error }, 'could not read whether auto-rollback is on: reporting it on');
        failing = true;
        result.observe(gauge, 1);
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
