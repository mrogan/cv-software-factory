/**
 * `factory probes`: the journeys a shopper takes, run against the app.
 *
 *     factory probes run
 *     factory probes once
 *
 * `run` looks at the app every few minutes, and at once when its version changes, and leaves a signal in the inbox
 * for each check that has failed twice in a row. `once` runs every check one time and prints what each found,
 * writing nothing to the inbox: for developing a probe.
 *
 * `run` also serves the page reader for triage (`POST /v1/pages` with a path, and `GET /health`) on PORT, 8080 by
 * default.
 *
 * Settings, from the environment: APP_URL, the app's address; ARTIFACTS_DIR, the artifact store's folder (`once`
 * uses a temporary one without it); DATABASE_URL or the PG* variables, the store's Postgres, as the factory's
 * writer; PROBE_INTERVAL, seconds between runs, 300 by default; VERSION_POLL, seconds between looks at the app's
 * version, 15 by default.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import postgres from 'postgres';
import { log } from '../log.ts';
import { inbox } from '../outbox.ts';
import { probes } from '../probes/index.ts';
import { readerServer } from '../probes/reader.ts';
import { versionOf } from '../senses/http.ts';
import { SenseRunner } from '../senses/runner.ts';

export const USAGE = `  factory probes run
  factory probes once`;

const seconds = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!(value > 0)) throw new Error(`${name} is a number of seconds, more than none`);
  return value * 1000;
};

export async function run(args: string[]): Promise<number> {
  const [command] = args;
  const app = process.env.APP_URL;
  if ((command !== 'run' && command !== 'once') || args.length !== 1) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  if (!app) {
    console.error('Set APP_URL to the app’s address, such as http://website.localhost:8080.');
    return 2;
  }
  if (command === 'run' && !process.env.ARTIFACTS_DIR) {
    console.error('Set ARTIFACTS_DIR to the artifact store’s folder.');
    return 2;
  }
  const store = new DiskArtifacts(process.env.ARTIFACTS_DIR ?? (await mkdtemp(join(tmpdir(), 'probes-'))));
  const sense = probes({ app: app.replace(/\/$/, ''), store, log });
  try {
    return command === 'once' ? await once(sense, app) : await loop(sense, app, store);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sense.close();
  }
}

async function once(sense: ReturnType<typeof probes>, app: string): Promise<number> {
  const version = await versionOf(app);
  console.log(`${app} is running ${version}\n`);
  let failed = 0;
  for (const observation of await sense.pass(version)) {
    const { check, finding, trouble } = observation;
    if (trouble) console.log(`  could not tell  ${check}: ${trouble}`);
    else if (finding) {
      failed++;
      console.log(`  FAIL  ${check}  [${finding.symptom}] ${observation.route}\n        ${finding.message}`);
    } else console.log(`  pass  ${check}`);
  }
  console.log(`\n${failed} failed.`);
  return 0;
}

async function loop(sense: ReturnType<typeof probes>, app: string, store: DiskArtifacts): Promise<number> {
  const sql = process.env.DATABASE_URL
    ? postgres(process.env.DATABASE_URL, { onnotice: () => {} })
    : postgres({ onnotice: () => {} });
  const runner = new SenseRunner({
    sense,
    log,
    version: () => versionOf(app),
    send: inbox(sql).send,
    every: seconds('PROBE_INTERVAL', 300),
  });
  const reader = readerServer({ app, sense, store, version: () => versionOf(app), log });
  const port = Number(process.env.PORT ?? 8080);
  await new Promise<void>((resolve) => reader.listen(port, resolve));
  log.info({ port }, 'the page reader is listening');
  const stop = runner.start(seconds('VERSION_POLL', 15));
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await stop();
  await new Promise((resolve) => reader.close(resolve));
  await sql.end();
  return 0;
}
