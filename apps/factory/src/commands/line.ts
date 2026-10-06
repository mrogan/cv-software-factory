/**
 * `factory line`: stopping and starting the line (guardrail 9: stop the line always works).
 *
 *     factory line stop [--reason <why>]
 *     factory line start [--autonomy supervised|guarded|lights-out]
 *     factory line serve
 *     factory line bench [<agent> [<fixture>]] [--commit <sha>]
 *     factory line soak-check [--since <time>] [--json]
 *
 * `serve` runs the line's server (`runners/serve.ts`): the handback for runners' agent pods, and the steps it runs in
 * the `runners` namespace. With LINE_MODE set to `live` or `dry-run`, it also runs the line itself (`line/worker.ts`):
 * it takes tickets and carries them through the agents, the gates and review to Martin's merge, acting in GitHub for
 * real or recording what it would have done. LINE_MODE is `off` by default: the line takes no tickets, and only the
 * step API and the smoke run work, and stopping the line still stops their agents. LINE_ONLY, a work item, has the
 * line act on that one alone: it takes the work item's ticket onto the line if it is not there, whatever else is in
 * Plan or Build, and starts no step for any other, reads nothing for it and appends nothing. It is unset by default,
 * when the line acts on every work item; a soak sets it to take one ticket end to end, with one step at a time on
 * the local model.
 *
 * Settings: RUNNER_IMAGE, the `factory-runner` image; GITHUB_WORKER_URL (default http://github:8080);
 * RUNNER_GATEWAY_URL and RUNNER_HANDBACK_URL, how an agent pod reaches the gateway and the handback; PORT (8080) and
 * HANDBACK_PORT (8081); KUBE_API_URL on a host (what `kubectl proxy` serves); LINE_MODE; LINE_ONLY; FACTORY_PROFILE (default
 * local) and ALL_LOCAL, as the gateway's: the profile's cap on a work item's spend, which the line holds at, and
 * where `policy/models.ts` sends each agent's calls, so a step on a local model is given longer to finish.
 *
 * `bench` runs one agent's step on this machine, on a fixture's invented work (`line/bench/`), against the gateway at
 * GATEWAY_URL (default http://localhost:8180), and prints what the agent handed back, whether its result fits the
 * agent's schema, how many of its calls the cassettes replayed, and how long it took. A coder's patch meets the scope
 * fence, and one it refuses goes back to the coder, as on the line. Without a fixture, it lists them. It works in the
 * bench's own folder (`BENCH_DIR`), the same on every run so that a run replays.
 *
 * `soak-check` reads the store and the cluster the morning after a soak (`line/soak.ts`): leases held past their
 * expiry, runners' Jobs and volumes left for ended work items, events that are not valid, the spend, and the work
 * items taken since `--since` (an ISO time; by default a day ago), by how each ended, with their minutes in each
 * stage. It prints a few lines, or the report as JSON, and exits 1 if anything is not as a soak should leave it. On
 * a host it reads the cluster through KUBE_API_URL (what `kubectl proxy` serves).
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
  factory line serve
  factory line bench [<agent> [<fixture>]] [--commit <sha>]
  factory line soak-check [--since <time>] [--json]`;

export async function run(args: string[]): Promise<number> {
  if (args[0] === 'bench') return bench(args.slice(1));
  if (args[0] === 'soak-check') return soakCheck(args.slice(1));
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

const MODES = ['off', 'dry-run', 'live'] as const;

async function serve(): Promise<number> {
  const { RUNNER_IMAGE, DATABASE_URL } = process.env;
  if (!RUNNER_IMAGE) {
    console.error('Set RUNNER_IMAGE to the factory-runner image, by digest.');
    return 2;
  }
  // The setting that lets the line act fails closed: anything but one of its values stops it starting.
  const mode = (process.env.LINE_MODE || 'off').trim() as (typeof MODES)[number];
  if (!MODES.includes(mode)) {
    console.error(`LINE_MODE is ${JSON.stringify(process.env.LINE_MODE)}; it must be one of ${MODES.join(', ')}.`);
    return 2;
  }
  // One work item, by its number, or none: anything else stops it starting, rather than the line acting on them all.
  const only = (process.env.LINE_ONLY ?? '').trim() || null;
  if (only !== null && !/^\d{1,12}$/.test(only)) {
    console.error(`LINE_ONLY is ${JSON.stringify(process.env.LINE_ONLY)}; it must be a work item's number, or unset.`);
    return 2;
  }
  // The work item's cap the gateway keeps, from the same profile, so the line holds a work item that reached it.
  const { PROFILES, SPEND } = await import('../../../../policy/spend.ts');
  const profile = (process.env.FACTORY_PROFILE || 'local').trim() as (typeof PROFILES)[number];
  if (!PROFILES.includes(profile)) {
    console.error(`FACTORY_PROFILE is ${JSON.stringify(profile)}; it must be one of ${PROFILES.join(', ')}.`);
    return 2;
  }
  // Where the gateway sends each agent's calls, from the same settings: the policy decides, and the line only reads it.
  const { MODEL_AGENTS, modelFor } = await import('../../../../policy/models.ts');
  const allLocal = process.env.ALL_LOCAL === 'true';
  let providerOf: (agent: Parameters<typeof modelFor>[1]) => 'anthropic' | 'bedrock' | 'local';
  try {
    for (const agent of MODEL_AGENTS) modelFor(profile, agent, allLocal);
    providerOf = (agent) => modelFor(profile, agent, allLocal).provider;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
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
  log.info({ port, handbackPort, mode, only }, `line listening on :${port}, the handback on :${handbackPort}`);

  // Off, the line takes no work, but still stops what the step API started when the line stops.
  const { Line } = await import('../line/worker.ts');
  const line = new Line({
    sql,
    // Line events carry no artifacts, so the writer never looks in the artifact store.
    events: new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts('/nonexistent') }),
    steps: runners,
    github: new GitHubWorker(env.GITHUB_WORKER_URL ?? 'http://github:8080', { dryRun: mode !== 'live' }),
    log,
    takesWork: mode !== 'off',
    workItemLimitUsd: SPEND[profile].workItemUsd,
    providerOf,
    only,
  });
  const abort = new AbortController();
  const working = line.run(abort.signal);
  await new Promise<void>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => resolve());
  });
  abort.abort();
  await working;
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => handback.close(r))]);
  await Promise.all([sql.end(), shutdownTelemetry()]);
  return 0;
}

async function bench(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { commit: { type: 'string' } } });
  const [agent, name] = positionals;
  const { FIXTURES } = await import('../line/bench/fixtures.ts');
  const fixtures = agent && Object.hasOwn(FIXTURES, agent) ? FIXTURES[agent as keyof typeof FIXTURES] : undefined;
  const fixture = fixtures && name && Object.hasOwn(fixtures, name) ? fixtures[name] : undefined;
  if (!agent || !fixtures || !fixture) {
    console.log(`Usage:\n  factory line bench <agent> <fixture> [--commit <sha>]\n\nFixtures:`);
    for (const [each, list] of Object.entries(FIXTURES)) {
      for (const [fixtureName, f] of Object.entries(list)) console.log(`  ${each} ${fixtureName}: ${f.about}`);
    }
    return agent ? 2 : 0;
  }
  // The runner's own steps, which only the bench loads: the factory's image does not hold them.
  const { prepare, commitPatch } = await import('../../../runner/src/prepare.ts');
  const { runAgent } = await import('../../../runner/src/agent.ts');
  const { bench: run, lastStep } = await import('../line/bench/bench.ts');
  const { DATABASE_URL, GATEWAY_URL } = process.env;
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  try {
    const benched = await run({
      agent: agent as keyof typeof FIXTURES,
      fixture,
      commit: values.commit,
      sql,
      gateway: GATEWAY_URL ?? 'http://localhost:8180',
      runner: { prepare, runAgent, commitPatch },
      log: (line) => console.error(line),
    });
    console.log(JSON.stringify(benched, null, 2));
    const last = lastStep(benched);
    return last.handback.ending === 'finished' && last.result.fits && last.fence?.ok !== false ? 0 : 1;
  } finally {
    await sql.end();
  }
}

async function soakCheck(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { since: { type: 'string' }, json: { type: 'boolean' } } });
  const now = new Date();
  const since = values.since ? new Date(values.since) : new Date(now.getTime() - 24 * 3_600_000);
  if (Number.isNaN(since.getTime())) {
    console.error(`--since is ${JSON.stringify(values.since)}; give a time, such as 2026-10-06T22:00:00Z.`);
    return 2;
  }
  const { soakFacts, soakReport, soakText } = await import('../line/soak.ts');
  const { kubeFrom } = await import('../runners/kube.ts');
  const { DATABASE_URL } = process.env;
  const sql = DATABASE_URL ? postgres(DATABASE_URL, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  try {
    const report = soakReport(await soakFacts({ sql, kube: () => kubeFrom(process.env), now, since }));
    console.log(values.json ? JSON.stringify(report, null, 2) : soakText(report));
    return report.ok ? 0 : 1;
  } finally {
    await sql.end();
  }
}
