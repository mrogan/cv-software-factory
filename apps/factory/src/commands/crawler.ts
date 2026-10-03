/**
 * `factory crawler`: follows every link, image, script and stylesheet from the app's home page, and checks what it
 * finds by the checks any site should pass.
 *
 *     factory crawler run
 *     factory crawler once
 *
 * `run` crawls every few minutes, and at once when the app's version changes, and leaves a signal in the inbox for
 * each check that has failed twice in a row. `once` crawls one time and prints what it found, writing nothing to the
 * inbox: for developing a check.
 *
 * Settings, from the environment: APP_URL, the app's address; ARTIFACTS_DIR, the artifact store's folder (`once`
 * uses a temporary one without it); DATABASE_URL or the PG* variables, the store's Postgres, as the factory's
 * writer; CRAWL_INTERVAL, seconds between crawls, 300 by default; CRAWL_LIMIT, the most resources a crawl asks for,
 * 150 by default; VERSION_POLL, seconds between looks at the app's version, 15 by default.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts, sendSignal } from '@software-factory/store';
import postgres from 'postgres';
import { Crawler } from '../crawler/index.ts';
import { log } from '../log.ts';
import { versionOf } from '../senses/http.ts';
import { SenseRunner } from '../senses/runner.ts';

export const USAGE = `  factory crawler run
  factory crawler once`;

const number = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!(value > 0)) throw new Error(`${name} is a number, more than none`);
  return value;
};

export async function run(args: string[]): Promise<number> {
  const [command] = args;
  const app = process.env.APP_URL?.replace(/\/$/, '');
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
  const store = new DiskArtifacts(process.env.ARTIFACTS_DIR ?? (await mkdtemp(join(tmpdir(), 'crawler-'))));
  const sense = new Crawler({ app, store, log, limit: number('CRAWL_LIMIT', 150) });
  try {
    return command === 'once' ? await once(sense, app) : await loop(sense, app);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  } finally {
    await sense.close();
  }
}

async function once(sense: Crawler, app: string): Promise<number> {
  const version = await versionOf(app);
  console.log(`${app} is running ${version}\n`);
  const observations = await sense.pass(version);
  const failed = observations.filter((o) => o.finding);
  for (const { check, finding } of failed) {
    console.log(`  FAIL  ${check}  [${finding?.symptom}]\n        ${finding?.message}`);
  }
  console.log(`\n${observations.length} checks, ${failed.length} failed.`);
  return 0;
}

async function loop(sense: Crawler, app: string): Promise<number> {
  const sql = process.env.DATABASE_URL
    ? postgres(process.env.DATABASE_URL, { onnotice: () => {} })
    : postgres({ onnotice: () => {} });
  const runner = new SenseRunner({
    sense,
    log,
    version: () => versionOf(app),
    send: async (signal) => void (await sendSignal(sql, signal)),
    every: number('CRAWL_INTERVAL', 300) * 1000,
  });
  const stop = runner.start(number('VERSION_POLL', 15) * 1000);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await stop();
  await sql.end();
  return 0;
}
