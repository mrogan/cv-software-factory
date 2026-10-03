/**
 * Replaces a store with an empty one for real events: `make real-store`. Every table, sequence and function goes,
 * the migrations run again, and the store is marked as real before anything is appended, so samples are refused
 * from the start. It refuses a store that already holds real events: they are the factory's own history.
 *
 *     DATABASE_URL=postgres://factory:…@localhost:5432/factory node packages/store/src/real-store.ts [--force]
 *
 * It connects as the database's owner, the only role that may drop the schema. The roles and their passwords
 * belong to the server, not the database, so they survive.
 */
import { parseArgs } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { migrate } from './migrate.ts';

export async function realStore(sql: Sql, { force = false } = {}): Promise<{ dropped: number }> {
  const dropped = (await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('migrations'))`;
    const [table] = await tx`select to_regclass('public.events') as name`;
    let held = { real: 0, all: 0 };
    if (table?.name) {
      [held = held] = await tx<{ real: number; all: number }[]>`
        select count(*) filter (where not sample)::int as real, count(*)::int as all from events`;
    }
    if (held.real && !force) {
      throw new Error(`This store holds ${held.real} real events. To delete them too, run it again with --force.`);
    }
    await tx.unsafe('drop schema public cascade');
    await tx.unsafe('create schema public');
    return held.all;
  })) as number;
  // Migrations take their own transaction. If they fail here, running this again starts from an empty schema.
  await migrate(sql);
  await sql`insert into store (sample) values (false)`;
  return { dropped };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { force: { type: 'boolean' } } });
  const url = process.env.DATABASE_URL;
  const sql = url ? postgres(url, { onnotice: () => {} }) : postgres({ onnotice: () => {} });
  try {
    const { dropped } = await realStore(sql, { force: values.force });
    console.log(`The store is empty, and takes real events only. ${dropped} events were deleted.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
