/**
 * Which of the gateway's errors are not a report's fault: triage waits them out without using up the report's
 * attempts (`JudgeWaiting` in `packages/triage`). Anything else is a real failure, and counts as one.
 */
import { JudgeWaiting } from '@software-factory/triage';
import { CassetteMissing, GatewayUnavailable, ProviderError, SpendCapped } from './errors.ts';

/** The provider's failures that pass. A rejected or malformed answer does not. */
const TRANSIENT: readonly string[] = ['rate-limited', 'overloaded', 'server', 'network', 'timeout'];
/** How long a report waits when the gateway or the provider cannot answer for now. */
const OUTAGE_WAIT_MS = 60_000;
/** How long a report with no cassette waits before it is tried again, when the gateway has no key. */
const NO_CASSETTE_WAIT_MS = 10 * 60_000;

export function waitingFor(error: unknown, now: Date): JudgeWaiting | undefined {
  const after = (ms: number) => new Date(now.getTime() + ms);
  if (error instanceof SpendCapped && error.resets) {
    return new JudgeWaiting(
      `The ${error.cap} spend cap is reached; triage waits until it resets`,
      new Date(error.resets),
    );
  }
  // The gateway restarting, or the provider rate-limiting, overloaded or down for a while: it waits a minute at a
  // time, however long the outage lasts.
  if (error instanceof GatewayUnavailable || (error instanceof ProviderError && TRANSIENT.includes(error.kind))) {
    return new JudgeWaiting(`${error.message} Triage tries again in a minute.`, after(OUTAGE_WAIT_MS));
  }
  if (error instanceof CassetteMissing) {
    return new JudgeWaiting(
      'No cassette for this report, and the gateway has no key to ask Jev',
      after(NO_CASSETTE_WAIT_MS),
    );
  }
  return undefined;
}
