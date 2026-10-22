/**
 * Readies Martin's own role in the store for a make target on the host (`as-operator` in the Makefile): as the
 * database's owner, it gives `factory_operator` the password read from stdin, so no pod need hold it, and prints the
 * role to connect as. A store not yet migrated to 0023 has no such role and guards none of Martin's commands, so it
 * prints the owner's own, which it connected as: `make stop-the-line` stops the line either way, and the next sync's
 * migrate Job gives the store his role. On a store migrated to 0023 whose role cannot append, it fails: a command
 * the owner appended there is one the factory ignores.
 *
 *     printf %s "$password" | PGHOST=… PGUSER=factory PGPASSWORD=… node packages/store/src/operator.ts
 */
import { text } from 'node:stream/consumers';
import type { Sql } from 'postgres';
import { connect } from './client.ts';

/** Gives Martin's role this password, as the owner, and says which role to connect as: his, or the owner's. */
export async function readyOperator(sql: Sql, password: string): Promise<string> {
  if (!password) throw new Error("No password for Martin's role");
  // Roles belong to the whole server, so another database may have made it: this one is migrated when the role may
  // append its events.
  const [role] = await sql<{ ready: boolean; migrated: boolean; owner: string }[]>`
    select case when exists (select 1 from pg_roles where rolname = 'factory_operator')
                then has_table_privilege('factory_operator', 'events', 'insert') else false end as ready,
           exists (select 1 from schema_migrations where version >= 23) as migrated,
           current_user as owner`;
  if (!role) throw new Error('The store did not say who it is');
  if (!role.ready && role.migrated) {
    throw new Error(
      "Martin's role cannot append events in this store, which is migrated to give it that: check its grants",
    );
  }
  if (!role.ready) return role.owner;
  // A role's password cannot be a query parameter; the literal is escaped instead.
  await sql.unsafe(`alter role factory_operator password '${password.replaceAll("'", "''")}'`);
  return 'factory_operator';
}

if (import.meta.main) {
  const sql = connect();
  try {
    const role = await readyOperator(sql, (await text(process.stdin)).trim());
    if (role !== 'factory_operator') {
      console.error("This store has no role for Martin yet (migration 0023): connecting as the database's owner.");
    }
    console.log(role);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
