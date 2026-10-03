/**
 * The console live, against a real store: events appended move an open console within a second, and a stream that
 * drops mid-play resumes with nothing missed and nothing twice. Needs Postgres: TEST_DATABASE_URL, or Docker.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import type { NewEvent } from '@software-factory/events';
import { logArtifactPath } from '@software-factory/events/log';
import { load, readLog } from '@software-factory/factory/events';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import { createDatabase, type Database, PASSWORDS, startPostgres } from '../../../packages/store/test/postgres.ts';
import { expect, test } from './support.ts';

const PORT = 18_324;
const HERE = fileURLToPath(new URL('..', import.meta.url));
const SAMPLES = fileURLToPath(new URL('../../../packages/samples/log', import.meta.url));

test.use({ baseURL: `http://localhost:${PORT}` });
test.describe.configure({ mode: 'serial' });

let postgres: { url: string; stop: () => void };
let database: Database;
let console_: ChildProcess | undefined;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));

/** The console, as the cluster runs it: its read-only role, and the artifact store's folder. */
async function startConsole(): Promise<ChildProcess> {
  const url = new URL(postgres.url);
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: HERE,
    env: {
      ...process.env,
      PORT: String(PORT),
      PGHOST: url.hostname,
      PGPORT: url.port,
      PGDATABASE: database.name,
      PGUSER: 'console_reader',
      PGPASSWORD: PASSWORDS.console,
      ARTIFACTS_DIR: artifacts.dir,
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      OTEL_SDK_DISABLED: 'true',
    },
    stdio: 'ignore',
  });
  for (let tries = 0; tries < 100; tries++) {
    if (
      await fetch(`http://localhost:${PORT}/health`).then(
        (r) => r.ok,
        () => false,
      )
    )
      return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The console did not start');
}

async function stopConsole(): Promise<void> {
  const child = console_;
  console_ = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

const received = (page: Page) => page.evaluate(() => (globalThis as { sfReceived?: number[] }).sfReceived ?? []);
const stored = async () =>
  (await database.owner<{ seq: string }[]>`select seq from events order by seq`).map((row) => Number(row.seq));

test.beforeAll(async () => {
  const given = process.env.TEST_DATABASE_URL;
  postgres = given ? { url: given, stop: () => {} } : await startPostgres();
  database = await createDatabase(postgres.url, 'live');
  // Every sample but the last, which the tests append themselves, once its screenshots are in the store.
  await load(database.writer, artifacts, SAMPLES, { except: ['1302'] });
  for (const event of live())
    for (const { hash } of event.artifacts) await artifacts.put(readFileSync(logArtifactPath(SAMPLES, hash)));
  console_ = await startConsole();
});

test.afterAll(async () => {
  await stopConsole();
  await database?.end();
  postgres?.stop();
});

/** #1302's events, each happening now. */
const live = (): NewEvent[] => readLog(SAMPLES, { only: ['1302'] });
const now = (event: NewEvent) => ({ ...event, ts: new Date().toISOString() }) as NewEvent;

test('moves an open console within a second of an append, with no refresh', async ({ page }) => {
  await page.goto('/?motion=off&debug=events');
  await expect(page.locator('.transport .count')).toHaveText('11 of 11');
  const [opened] = live();
  if (!opened) throw new Error('No events for #1302');
  const writer = new EventWriter(database.writer, { kind: 'sample', artifacts });
  const appended = Date.now();
  await writer.append(now(opened));
  await expect(page.locator('.transport .count')).toHaveText('12 of 12', { timeout: 1000 });
  console.log(`The console showed the new work item ${Date.now() - appended} ms after the append`);
});

test('resumes after the stream drops mid-play, with nothing missed and nothing twice', async ({ page }) => {
  await page.goto('/?motion=off&debug=events');
  await expect(page.locator('.transport .count')).toHaveText('12 of 12');
  const writer = new EventWriter(database.writer, { kind: 'sample', artifacts });
  const rest = live().slice(1);
  const half = Math.floor(rest.length / 2);
  for (const [i, event] of rest.entries()) {
    if (i === half) {
      // The console goes away mid-play, connections and all, and comes back.
      await stopConsole();
      await writer.append(now(event));
      console_ = await startConsole();
      continue;
    }
    await writer.append(now(event));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const all = await stored();
  await expect.poll(() => received(page), { timeout: 10_000 }).toHaveLength(all.length);
  const seqs = await received(page);
  expect(new Set(seqs).size, 'no event sent twice').toBe(seqs.length);
  expect(
    [...seqs].sort((a, b) => a - b),
    'every stored event, and only those',
  ).toEqual(all);
  await expect(page.locator('.card[data-place="centre"] h3')).toHaveText('Search turns away long words');
});
