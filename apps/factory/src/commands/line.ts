/**
 * `factory line`: stopping and starting the line (guardrail 9: stop the line always works).
 *
 *     factory line stop [--reason <why>]
 *     factory line start [--autonomy supervised|guarded|lights-out]
 *     factory line serve
 *
 * `serve` runs the line's server (`runners/serve.ts`): the handback for runners' agent pods, and the steps it runs in
 * the `runners` namespace. Settings: RUNNER_IMAGE, the `factory-runner` image; GITHUB_WORKER_URL (default
 * http://github:8080); RUNNER_GATEWAY_URL and RUNNER_HANDBACK_URL, how an agent pod reaches the gateway and the
 * handback; PORT (8080) and HANDBACK_PORT (8081); KUBE_API_URL on a host (what `kubectl proxy` serves).
 *
 * Every worker checks the line before it takes work, so a stopped line finishes what is in hand and takes nothing
 * new; signals wait in the inbox until it starts again. Connects with DATABASE_URL, or the PG* variables, as the
 * factory's writer.
 */
import { parseArgs } from 'node:util';
import { AUTONOMY, type Autonomy, type NewEvent, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import postgres from 'postgres';

export const USAGE = `  factory line stop [--reason <why>]
  factory line start [--autonomy supervised|guarded|lights-out]
  factory line serve`;

export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      reason: { type: 'string', default: 'Martin stopped the line' },
      autonomy: { type: 'string', default: 'supervised' },
    },
  });
  const [command] = positionals;
  if (command === 'serve') return serve();
  const autonomy = values.autonomy as Autonomy;
  if ((command !== 'stop' && command !== 'start') || !AUTONOMY.includes(autonomy)) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  const { DATABASE_URL } = process.env;
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  // Line events carry no artifacts, so the writer never looks in the artifact store.
  const writer = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') });
  const event = (type: 'line.stopped' | 'line.started', summary: string, payload: object) =>
    ({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      work_item: null,
      type,
      version: VERSIONS[type],
      actor: 'martin',
      summary,
      payload,
      artifacts: [],
    }) as NewEvent;
  try {
    if (command === 'stop') {
      await writer.append(event('line.stopped', `The line stopped: ${values.reason}`, { reason: values.reason }));
      console.log('The line is stopped. Workers finish what they hold and take nothing new.');
    } else {
      await writer.append(event('line.started', `The line started, ${autonomy}`, { autonomy }));
      console.log(`The line is running, ${autonomy}. Workers take what waited in the inbox.`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sql.end();
  }
}

async function serve(): Promise<number> {
  const { RUNNER_IMAGE, DATABASE_URL } = process.env;
  if (!RUNNER_IMAGE) {
    console.error('Set RUNNER_IMAGE to the factory-runner image, by digest.');
    return 2;
  }
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { log } = await import('../log.ts');
  const { kubeFrom } = await import('../runners/kube.ts');
  const { Runners } = await import('../runners/steps.ts');
  const { lineServers } = await import('../runners/serve.ts');
  const { GitHubWorker } = await import('../github/worker-client.ts');
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  const env = process.env;
  const runners = new Runners({
    sql,
    kube: kubeFrom(env),
    image: RUNNER_IMAGE,
    gatewayUrl: env.RUNNER_GATEWAY_URL ?? 'http://gateway.factory.svc:8080',
    handbackUrl: env.RUNNER_HANDBACK_URL ?? 'http://line.factory.svc:8081/v1/handback',
    log,
  });
  // The smoke run asks for a dry run; the steps Part B runs will say what they want.
  const github = new GitHubWorker(env.GITHUB_WORKER_URL ?? 'http://github:8080', { dryRun: true });
  const { api, handback } = lineServers({ runners, github, log });
  const port = Number(env.PORT ?? 8080);
  const handbackPort = Number(env.HANDBACK_PORT ?? 8081);
  // The step API on loopback only: a port-forward reaches it, and no pod can. Agent pods call the handback.
  await new Promise<void>((resolve) => api.listen(port, '127.0.0.1', resolve));
  await new Promise<void>((resolve) => handback.listen(handbackPort, resolve));
  log.info({ port, handbackPort }, `line listening on :${port}, the handback on :${handbackPort}`);
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve());
  });
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => handback.close(r))]);
  await Promise.all([sql.end(), shutdownTelemetry()]);
  return 0;
}
