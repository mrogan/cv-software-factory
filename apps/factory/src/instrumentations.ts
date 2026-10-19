/**
 * What the factory's workers trace, apart from where they send it (`telemetry.ts`), so a test can install the same.
 */
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PinoInstrumentation } from '@opentelemetry/instrumentation-pino';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { untracedIncoming, untracedOutgoing } from './untraced.ts';

/**
 * Requests in through `node:http`, requests out through `node:http` and `fetch`, and pino's records stamped with the
 * trace they were written in. Routine polling is left out: a span for each would bury the requests that matter.
 *
 * A request out makes a client span, and sends `traceparent`, only inside a span, whichever way it is made: the
 * gateway's calls to its providers and the GitHub worker's to GitHub, inside the request that asked for them, join its
 * trace. The polling workers' rounds (the probes', the crawler's, the log watcher's, traffic's, and the line's loop
 * outside the spans it starts for a step, a release or a look, `spans.ts`) run outside any span, so their requests out
 * make no span and send no trace, and nothing needs sampling. Each still adds to the client's request duration
 * histogram, as every request does.
 */
export function instrumentations() {
  return [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: untracedIncoming,
      ignoreOutgoingRequestHook: untracedOutgoing,
      requireParentforOutgoingSpans: true,
    }),
    new UndiciInstrumentation({ requireParentforSpans: true, ignoreRequestHook: untracedOutgoing }),
    new PinoInstrumentation(),
  ];
}
