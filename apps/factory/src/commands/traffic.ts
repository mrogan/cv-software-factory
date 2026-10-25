/**
 * `factory traffic`: the traffic generator (`traffic/traffic.ts`), which walks the app's public pages and its search
 * at the rate policy/release.ts sets, until it is stopped.
 *
 *     factory traffic [--walk]
 *
 * `--walk` prints the round it would walk, and sends nothing more. Settings, from the environment: APP_URL, the app's
 * public address, such as http://website.localhost:8080; and INGRESS_URL, the ingress to connect to instead, sending
 * APP_URL's host, where that name does not resolve (in the cluster, http://traefik.kube-system); and SHARE_KEY_FILE,
 * the generator's private key (PEM), from its Secret, with which it signs an id on each request for a flag's share
 * stage. With no key there, or one it cannot use, it says so once and sends no id. Run with the preload, it sends its
 * own traces, metrics and logs to the collector, and its figures for each request, by id, as metrics.
 */
import { parseArgs } from 'node:util';
import { release } from '../../../../policy/release.ts';

export const USAGE = '  factory traffic [--walk]';

/**
 * The buckets of the generator's own latency, in seconds: finest around a tenth of a second, the least by which a
 * canary's slower tail fails (policy/release.ts), and up to the ten seconds after which it gives up on a request.
 */
export const DURATION_BUCKETS = [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2.5, 5, 10] as const;

export async function run(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { walk: { type: 'boolean', default: false } } });
  const { APP_URL, INGRESS_URL, SHARE_KEY_FILE } = process.env;
  if (!APP_URL) {
    console.error('Set APP_URL to the app’s public address, such as http://website.localhost:8080.');
    return 2;
  }
  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { metrics } = await import('@opentelemetry/api');
  const { discover, httpGet, round, Traffic } = await import('../traffic/traffic.ts');
  const { IDS, readShareKey, signer } = await import('../traffic/share.ts');

  const get = httpGet(APP_URL, { ingress: INGRESS_URL });
  if (values.walk) {
    const walk = round(await discover(get));
    console.log(walk.join('\n'));
    console.log(
      `\n${walk.length} requests a round, ${(walk.length / release.traffic.requestsPerSecond).toFixed(0)} s.`,
    );
    await shutdownTelemetry();
    return 0;
  }

  const share = SHARE_KEY_FILE ? await readShareKey(SHARE_KEY_FILE) : { none: 'SHARE_KEY_FILE is not set' };
  if ('none' in share) log.warn({ reason: share.none }, 'no signing key: sending no ids, so no request is in a share');
  const meter = metrics.getMeter('factory-traffic');
  const requests = meter.createCounter('factory.traffic.requests', {
    description: 'Requests the traffic generator sent, by the status that answered (none when no answer came)',
  });
  const durations = meter.createHistogram('factory.traffic.request.duration', {
    description:
      'How long each of the traffic generator’s requests took, as it measured it, by the id it carried (none without ' +
      'its key) and the class of the status that answered (none when no answer came)',
    unit: 's',
    advice: { explicitBucketBoundaries: [...DURATION_BUCKETS] },
  });
  const traffic = new Traffic({
    get,
    rate: release.traffic.requestsPerSecond,
    log,
    ...('key' in share ? { sign: signer(share.key, new URL(APP_URL).host) } : {}),
    sent: ({ status, seconds, id }) => {
      requests.add(1, { status: status === null ? 'none' : String(status) });
      durations.record(seconds, {
        share_id: id ?? 'none',
        status_class: status === null ? 'none' : `${Math.floor(status / 100)}xx`,
      });
    },
  });
  await traffic.start();
  log.info(
    {
      app: APP_URL,
      ingress: INGRESS_URL,
      rate: release.traffic.requestsPerSecond,
      round: traffic.walk.length,
      ids: 'key' in share ? IDS.length : 0,
    },
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
