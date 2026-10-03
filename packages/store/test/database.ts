/**
 * A fresh database for a test file, on the Postgres the setup provides (postgres.ts), migrated, with a connection
 * as each role: the owner (as the migration Job connects), the factory's writer and the console's reader.
 */
import postgres, { type Sql } from 'postgres';
import { inject } from 'vitest';
import { migrate } from '../src/migrate.ts';

const PASSWORDS = { writer: 'writer-test-password', console: 'console-test-password' };
const quiet = { onnotice: () => {}, max: 2 };

export interface Database {
  owner: Sql;
  writer: Sql;
  reader: Sql;
  end(): Promise<void>;
}

export async function freshDatabase(name: string): Promise<Database> {
  const database = `${name}_${process.pid}_${Date.now()}`;
  const url = new URL(inject('databaseUrl'));
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
    owner,
    writer,
    reader,
    end: async () => {
      await Promise.all([owner.end(), writer.end(), reader.end()]);
    },
  };
}
