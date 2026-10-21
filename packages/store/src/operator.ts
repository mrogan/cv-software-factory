/**
 * Readies Martin's own role in the store for a make target on the host (`as-operator` in the Makefile): as the
 * database's owner, it gives `factory_operator` the password read from stdin, so no pod need hold it, and prints the
 * role to connect as. A store not yet migrated to 0023 has no such role and guards none of Martin's commands, so it
 * prints the writer's, which may still append them there: `make stop-the-line` stops the line either way.
 *
 *     printf %s "$password" | PGHOST=… PGUSER=factory PGPASSWORD=… node packages/store/src/operator.ts
 */
import { text } from 'node:stream/consumers';
import type { Sql } from 'postgres';
import { connect } from './client.ts';

/** Gives Martin's role this password, as the owner, and says which role to connect as. */
export async function readyOperator(sql: Sql, password: string): Promise<'factory_operator' | 'factory_writer'> {
  if (!password) throw new Error("No password for Martin's role");
  // Roles belong to the whole server, so another database may have made it: this one is migrated when the role may
  // append its events.
  const [role] = await sql<{ ready: boolean }[]>`
    select case when exists (select 1 from pg_roles where rolname = 'factory_operator')
                then has_table_privilege('factory_operator', 'events', 'insert') else false end as ready`;
  if (!role?.ready) return 'factory_writer';
  // A role's password cannot be a query parameter; the literal is escaped instead.
  await sql.unsafe(`alter role factory_operator password '${password.replaceAll("'", "''")}'`);
  return 'factory_operator';
}

if (import.meta.main) {
  const sql = connect();
  try {
    const role = await readyOperator(sql, (await text(process.stdin)).trim());
    if (role === 'factory_writer') {
      console.error("This store has no role for Martin yet (migration 0023): connecting as the factory's writer.");
    }
    console.log(role);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
