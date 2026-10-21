/**
 * Applies the numbered SQL migrations in `migrations/` that a database has not had yet, together in one
 * transaction, so a failure leaves the schema as it was, then sets the roles' passwords. In the cluster an Argo CD
 * hook Job runs it before the console starts; on the host:
 *
 *     DATABASE_URL=postgres://factory:…@localhost:5432/factory pnpm migrate
 *
 * Each of the variables in `PASSWORDS`, when set, becomes the password of its role: WRITER_PASSWORD the factory's
 * writer's, CONSOLE_PASSWORD the console's reader's, SCOREBOARD_PASSWORD the scoreboard's writer's, METRICS_PASSWORD
 * the Postgres exporter's reader's, and TRIAGE_PASSWORD, LINE_PASSWORD and the like each worker's own. It connects as
 * the database's owner, the only role that may change its schema.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import { connect } from './client.ts';

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The migrations in order. A file is `<version>_<name>.sql`, and versions must not repeat. */
export function migrations(dir = MIGRATIONS): Migration[] {
  const found = readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = /^(\d+)_([a-z0-9-_]+)\.sql$/.exec(file);
      if (!match) throw new Error(`${file} is not named <version>_<name>.sql`);
      return { version: Number(match[1]), name: match[2] ?? '', sql: readFileSync(`${dir}${file}`, 'utf-8') };
    })
    .sort((a, b) => a.version - b.version);
  found.forEach((m, i) => {
    if (i > 0 && m.version === found[i - 1]?.version) throw new Error(`Two migrations are version ${m.version}`);
  });
  return found;
}

/** Each role that logs in, by the name its password goes by here, and the variable that gives it in the cluster. */
export const PASSWORDS = {
  writer: { role: 'factory_writer', variable: 'WRITER_PASSWORD' },
  console: { role: 'console_reader', variable: 'CONSOLE_PASSWORD' },
  scoreboard: { role: 'scoreboard_writer', variable: 'SCOREBOARD_PASSWORD' },
  metrics: { role: 'metrics_reader', variable: 'METRICS_PASSWORD' },
  // Each worker's own (0022_worker-roles.sql).
  triage: { role: 'factory_triage', variable: 'TRIAGE_PASSWORD' },
  line: { role: 'factory_line', variable: 'LINE_PASSWORD' },
  gateway: { role: 'factory_gateway', variable: 'GATEWAY_PASSWORD' },
  probes: { role: 'factory_probes', variable: 'PROBES_PASSWORD' },
  crawler: { role: 'factory_crawler', variable: 'CRAWLER_PASSWORD' },
  intake: { role: 'factory_intake', variable: 'INTAKE_PASSWORD' },
  logs: { role: 'factory_logs', variable: 'LOGS_PASSWORD' },
} as const;

export type Passwords = { [name in keyof typeof PASSWORDS]?: string | undefined };

/** Applies what is pending and returns the names of the migrations it applied. */
export async function migrate(sql: Sql, passwords: Passwords = {}): Promise<string[]> {
  const applied: string[] = [];
  // Two Jobs at once would race; the second waits for the first, then finds nothing to do.
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('migrations'))`;
    await tx`
      create table if not exists schema_migrations (
        version integer primary key,
        name text not null,
        applied_at timestamptz not null default now()
      )`;
    const done = new Set(
      (await tx<{ version: number }[]>`select version from schema_migrations`).map((r) => r.version),
    );
    for (const migration of migrations()) {
      if (done.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`insert into schema_migrations (version, name) values (${migration.version}, ${migration.name})`;
      applied.push(`${migration.version}_${migration.name}`);
    }
  });
  for (const [name, { role }] of Object.entries(PASSWORDS)) {
    const password = passwords[name as keyof Passwords];
    // A role's password cannot be a query parameter; the literal is escaped instead.
    if (password) await sql.unsafe(`alter role ${role} password '${password.replaceAll("'", "''")}'`);
  }
  return applied;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  const sql = connect(url);
  try {
    const passwords = Object.fromEntries(
      Object.entries(PASSWORDS).map(([name, { variable }]) => [name, process.env[variable]]),
    ) as Passwords;
    const applied = await migrate(sql, passwords);
    console.log(applied.length ? `Applied ${applied.join(', ')}.` : 'Nothing to apply: the schema is current.');
  } finally {
    await sql.end();
  }
}
