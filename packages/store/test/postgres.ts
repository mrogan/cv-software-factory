/**
 * A real Postgres for the store's tests: TEST_DATABASE_URL if it is set, or else a throwaway container of the same
 * image the cluster runs, removed with its data when the tests finish. CI names its own copy of that image in
 * TEST_POSTGRES_IMAGE.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import postgres, { type Sql } from 'postgres';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/migrate.ts';

export const PASSWORDS = {
  writer: 'writer-test-password',
  console: 'console-test-password',
  scoreboard: 'scoreboard-test-password',
  metrics: 'metrics-test-password',
};
const quiet = { onnotice: () => {}, max: 2 };

export interface Database {
  name: string;
  owner: Sql;
  writer: Sql;
  reader: Sql;
  scoreboard: Sql;
  metrics: Sql;
  end(): Promise<void>;
}

// The image the cluster runs: its one pin is its StatefulSet's.
const STATEFULSET = new URL('../../../deploy/base/postgres/statefulset.yaml', import.meta.url);
function image() {
  const pinned = readFileSync(STATEFULSET, 'utf-8').match(/^\s+image: (\S+)$/m)?.[1];
  if (!pinned) throw new Error(`No Postgres image in ${STATEFULSET.pathname}`);
  return process.env.TEST_POSTGRES_IMAGE || pinned;
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

// Each container is labelled with the process that started it, and when that process started, so a later run can
// find one whose process died before it could remove it, even once the process's id has gone to another.
const PID = 'software-factory-test.pid';
const STARTED = 'software-factory-test.started';
const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
// The image keeps its data in an anonymous volume, which `rm` leaves behind unless asked: gigabytes after a full run.
const remove = (...names: string[]) => void docker('rm', '--force', '--volumes', ...names);

/** Removes the containers, with their data, of runs that were killed before they could. Other runs' are kept. */
function sweep() {
  // Tidying up is a courtesy: if it fails, no tests do.
  try {
    const format = `{{.ID}}\t{{.Label "${PID}"}}\t{{.Label "${STARTED}"}}`;
    const orphans = docker('ps', '--all', '--filter', `label=${PID}`, '--format', format)
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t'))
      .filter(([, pid, at]) => started(Number(pid)) !== at)
      .map(([id]) => id as string);
    if (orphans.length) remove(...orphans);
  } catch {}
}

/** When a process started, as `ps` puts it, or nothing if it isn't running. Any user's process counts. */
function started(pid: number) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: 'pipe',
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
  } catch {
    return '';
  }
}

/** A throwaway Postgres in Docker, ready for connections, and how to remove it. */
export async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  try {
    docker('info', '--format', '{{.ServerVersion}}');
  } catch {
    throw new Error('These tests need Postgres: set TEST_DATABASE_URL, or start Docker so they can run their own.');
  }
  sweep();
  const name = `software-factory-test-${process.pid}-${Date.now()}`;
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--label',
    `${PID}=${process.pid}`,
    '--label',
    `${STARTED}=${started(process.pid)}`,
    '--env',
    'POSTGRES_USER=factory',
    '--env',
    'POSTGRES_PASSWORD=test',
    '--publish',
    '127.0.0.1::5432',
    image(),
  );
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  // pg_isready answers before the server takes connections from outside; a query proves it does.
  for (let tries = 0; ; tries++) {
    try {
      docker('exec', name, 'psql', '-U', 'factory', '-h', '127.0.0.1', '-c', 'select 1');
      break;
    } catch (error) {
      // A minute: a slow runner's first initdb takes a while.
      if (tries > 240) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { url: `postgres://factory:test@127.0.0.1:${port}/postgres`, stop: () => remove(name) };
}

export default async function setup(project: TestProject) {
  const given = process.env.TEST_DATABASE_URL;
  if (given) {
    project.provide('databaseUrl', given);
    return;
  }
  const postgres = await startPostgres();
  project.provide('databaseUrl', postgres.url);
  return postgres.stop;
}

/** A fresh database on a given Postgres, migrated, with a connection as each role. */
export async function createDatabase(server: string, name: string): Promise<Database> {
  const database = `${name}_${process.pid}_${Date.now()}`;
  const url = new URL(server);
  const as = (username: string, password: string) =>
    postgres({ ...quiet, host: url.hostname, port: Number(url.port), database, username, password });
  const owner = as(decodeURIComponent(url.username), decodeURIComponent(url.password));
  // Test files run at once, and roles and their passwords belong to the whole server: one migration at a time.
  // (Advisory locks belong to a database, so the lock is taken in the server's own.)
  const admin = postgres(url.href, { ...quiet, max: 1 });
  try {
    await admin`select pg_advisory_lock(hashtext('test migrations'))`;
    await admin.unsafe(`create database ${database}`);
    await migrate(owner, PASSWORDS);
  } finally {
    await admin.end();
  }
  const writer = as('factory_writer', PASSWORDS.writer);
  const reader = as('console_reader', PASSWORDS.console);
  const scoreboard = as('scoreboard_writer', PASSWORDS.scoreboard);
  const metrics = as('metrics_reader', PASSWORDS.metrics);
  return {
    name: database,
    owner,
    writer,
    reader,
    scoreboard,
    metrics,
    end: async () => {
      await Promise.all([owner.end(), writer.end(), reader.end(), scoreboard.end(), metrics.end()]);
    },
  };
}
