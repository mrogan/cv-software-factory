/**
 * Readies one of Martin's own roles in the store for a make target on the host, as the database's owner: it gives the
 * role the password read from stdin, so no pod need hold it, and prints the role to connect as.
 *
 * - `factory_operator` (`as-operator` in the Makefile: `make stop-the-line`, `make start-the-line`, `make samples`). A
 *   store not yet migrated to 0023 has no such role and guards none of Martin's commands, so it prints the writer's,
 *   which may still append them there: `make stop-the-line` stops the line either way.
 * - `factory_enrol` (`make enrol`). A store not yet migrated to 0025 cannot record what the enrolment revokes, so it
 *   fails: there is no other role to enrol with.
 *
 *     printf %s "$password" | PGHOST=… PGUSER=factory PGPASSWORD=… node packages/store/src/operator.ts [factory_enrol]
 */
import { text } from 'node:stream/consumers';
import type { Sql } from 'postgres';
import { connect } from './client.ts';

/** Martin's roles a make target connects as, and the privilege that says a store is migrated far enough for each. */
const READY = {
  factory_operator: { table: 'events', privilege: 'insert' },
  factory_enrol: { table: 'events', privilege: 'insert' },
} as const;

export type MartinsRole = keyof typeof READY;

/** Gives one of Martin's roles this password, as the owner, if the store is migrated far enough for it. */
export async function readyRole(sql: Sql, role: MartinsRole, password: string): Promise<boolean> {
  if (!password) throw new Error(`No password for ${role}`);
  const { table, privilege } = READY[role];
  // Roles belong to the whole server, so another database may have made it: this one is migrated when the role may
  // do what it is for here.
  const [found] = await sql<{ ready: boolean }[]>`
    select case when exists (select 1 from pg_roles where rolname = ${role})
                then has_table_privilege(${role}, ${table}, ${privilege}) else false end as ready`;
  if (!found?.ready) return false;
  // A role's password cannot be a query parameter; the literal is escaped instead. The role is one of two names.
  await sql.unsafe(`alter role ${role} password '${password.replaceAll("'", "''")}'`);
  return true;
}

/** Gives Martin's role this password, as the owner, and says which role to connect as. */
export async function readyOperator(sql: Sql, password: string): Promise<'factory_operator' | 'factory_writer'> {
  return (await readyRole(sql, 'factory_operator', password)) ? 'factory_operator' : 'factory_writer';
}

if (import.meta.main) {
  const role = process.argv[2] ?? 'factory_operator';
  const sql = connect();
  try {
    if (!Object.hasOwn(READY, role)) throw new Error(`${role} is not one of Martin's roles: ${Object.keys(READY)}`);
    const password = (await text(process.stdin)).trim();
    if (role === 'factory_operator') {
      const connectAs = await readyOperator(sql, password);
      if (connectAs === 'factory_writer') {
        console.error("This store has no role for Martin yet (migration 0023): connecting as the factory's writer.");
      }
      console.log(connectAs);
    } else if (await readyRole(sql, role as MartinsRole, password)) {
      console.log(role);
    } else {
      throw new Error('This store cannot enrol a passkey yet (migration 0025): deploy the image that migrates it.');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
