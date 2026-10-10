/**
 * `factory traffic`: the traffic generator (`traffic/traffic.ts`), which walks the shop's public pages and its search
 * at the rate policy/release.ts sets, until it is stopped.
 *
 *     factory traffic [--walk]
 *
 * `--walk` prints the round it would walk, and sends nothing more. Settings, from the environment: APP_URL, the shop's
 * public address, such as http://website.localhost:8080; and INGRESS_URL, the ingress to connect to instead, sending
 * APP_URL's host, where that name does not resolve (in the cluster, http://traefik.kube-system). Run with the preload,
 * it sends its own traces, metrics and logs to the collector.
 */
import { parseArgs } from 'node:util';
import { release } from '../../../../policy/release.ts';

export const USAGE = '  factory traffic [--walk]';

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { walk: { type: 'boolean', default: false } } });
  const { APP_URL, INGRESS_URL } = process.env;
  if (!APP_URL) {
    console.error('Set APP_URL to the shop’s public address, such as http://website.localhost:8080.');
    return 2;
  }
  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { metrics } = await import('@opentelemetry/api');
  const { discover, httpGet, round, Traffic } = await import('../traffic/traffic.ts');

  const get = httpGet(APP_URL, INGRESS_URL);
  if (values.walk) {
    const walk = round(await discover(get));
    console.log(walk.join('\n'));
    console.log(
      `\n${walk.length} requests a round, ${(walk.length / release.traffic.requestsPerSecond).toFixed(0)} s.`,
    );
    await shutdownTelemetry();
    return 0;
  }

  const requests = metrics.getMeter('factory-traffic').createCounter('factory.traffic.requests', {
    description: 'Requests the traffic generator sent, by the status that answered (none when no answer came)',
  });
  const traffic = new Traffic({
    get,
    rate: release.traffic.requestsPerSecond,
    log,
    sent: (status) => requests.add(1, { status: status === null ? 'none' : String(status) }),
  });
  await traffic.start();
  log.info(
    { app: APP_URL, ingress: INGRESS_URL, rate: release.traffic.requestsPerSecond, round: traffic.walk.length },
    'sending traffic',
  );

  // Kubernetes sends SIGTERM before it stops the pod: let the requests in flight finish, then flush telemetry.
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'traffic stopping');
        resolve();
      });
    }
  });
  await traffic.stop();
  await shutdownTelemetry();
  return 0;
}
