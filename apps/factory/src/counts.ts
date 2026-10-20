/**
 * Sends the metrics as they stand, for a worker that has just started its counts at 0. A count's 0 has to reach
 * Prometheus before its first 1 does: in one export together, the series' first sample is the 1, which `increase`
 * and `changes` read nothing into, and the first is lost all the same. With no SDK started, as in a one-off command,
 * there is nothing to send. It waits at most `ms`, so a collector that is down holds up no worker, and a failed send
 * only leaves the first of each kind uncounted, as before.
 */
import { metrics } from '@opentelemetry/api';

export async function sendCounts(ms = 5_000): Promise<void> {
  const provider = metrics.getMeterProvider() as { forceFlush?: () => Promise<void> };
  if (!provider.forceFlush) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    provider.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}
