/**
 * Where a sense leaves its signals: the inbox, or, for a dry run, the terminal. Either way each signal is counted
 * as `factory_signals_total{sense}`, which the factory's dashboard shows.
 */
import { metrics } from '@opentelemetry/api';
import type { InboxSignal } from '@software-factory/events';
import { sendSignal } from '@software-factory/store';
import type { Sql } from 'postgres';

export interface Outbox {
  /**
   * Leaves the signal. A sender that gives an id may send the same signal again with it: the inbox keeps the first and
   * drops the rest. Without one, each send is a signal of its own.
   */
  send(signal: InboxSignal, id?: string): Promise<void>;
}

// A no-op until telemetry.ts has started the SDK, so tests and one-off commands count nothing.
const signals = metrics.getMeter('factory').createCounter('factory_signals', {
  description: 'Signals the senses have left in the inbox',
  unit: '1',
});

/** The inbox, in Postgres. */
export function inbox(sql: Sql): Outbox {
  return {
    async send(signal, id) {
      await sendSignal(sql, signal, id);
      signals.add(1, { sense: signal.sense });
    },
  };
}

/** The terminal, one JSON line a signal. A report's text is replaced by its length: even a dry run keeps it off screen. */
export function printing(print: (line: string) => void): Outbox {
  return {
    async send(signal) {
      const shown = signal.report?.text
        ? { ...signal, report: { ...signal.report, text: `(${signal.report.text.length} characters)` } }
        : signal;
      print(JSON.stringify(shown));
    },
  };
}
