/**
 * What the factory's workers trace, apart from where they send it (`telemetry.ts`), so a test can install the same.
 */
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { untracedIncoming, untracedOutgoing } from './untraced.ts';

/**
 * Requests in and out through `node:http`, `fetch` out, and pino's records stamped with the trace they were written in.
 * Routine polling, in and out, is left out: a span for each would bury the requests that matter.
 *
 * A `fetch` makes a client span, and sends `traceparent`, only inside a span: the gateway's calls to its providers and
 * the GitHub worker's to GitHub, inside the request that asked for them, join its trace. The polling workers (the
 * probes, the crawler, the log watcher, traffic) fetch outside any span, so they make no trace at all, and nothing
 * needs sampling.
 */
export function instrumentations() {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: untracedIncoming,
      ignoreOutgoingRequestHook: untracedOutgoing,
    }),
    new UndiciInstrumentation({ requireParentforSpans: true, ignoreRequestHook: untracedOutgoing }),
    new PinoInstrumentation(),
  ];
}
