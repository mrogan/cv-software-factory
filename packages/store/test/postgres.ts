/**
 * A real Postgres for the store's tests: TEST_DATABASE_URL if it is set (CI sets it to a service container), or
 * else a throwaway container of the same image the cluster runs, removed when the tests finish.
 */
import { execFileSync } from 'node:child_process';
import postgres, { type Sql } from 'postgres';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/migrate.ts';

export const PASSWORDS = { writer: 'writer-test-password', console: 'console-test-password' };
const quiet = { onnotice: () => {}, max: 2 };

export interface Database {
  name: string;
  owner: Sql;
  writer: Sql;
  reader: Sql;
  end(): Promise<void>;
}

// The image deploy/base/postgres/statefulset.yaml runs.
const IMAGE = 'postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** A throwaway Postgres in Docker, ready for connections, and how to remove it. */
export async function startPostgres(): Promise<{ url: string; stop: () => void }> {
  const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  try {
    docker('info', '--format', '{{.ServerVersion}}');
  } catch {
    throw new Error('These tests need Postgres: set TEST_DATABASE_URL, or start Docker so they can run their own.');
  }
  const name = `software-factory-test-${process.pid}-${Date.now()}`;
  docker(
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--env',
    'POSTGRES_USER=factory',
    '--env',
    'POSTGRES_PASSWORD=test',
    '--publish',
    '127.0.0.1::5432',
    IMAGE,
  );
  const port = docker('port', name, '5432/tcp').split(':').at(-1);
  // pg_isready answers before the server takes connections from outside; a query proves it does.
  for (let tries = 0; ; tries++) {
    try {
      docker('exec', name, 'psql', '-U', 'factory', '-h', '127.0.0.1', '-c', 'select 1');
      break;
    } catch (error) {
      if (tries > 60) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return { url: `postgres://factory:test@127.0.0.1:${port}/postgres`, stop: () => void docker('rm', '--force', name) };
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
  return {
    name: database,
    owner,
    writer,
    reader,
    end: async () => {
      await Promise.all([owner.end(), writer.end(), reader.end()]);
    },
  };
}
