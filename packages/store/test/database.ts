/**
 * A fresh database for a test file, on the Postgres the setup provides (postgres.ts), migrated, with a connection
 * as each role: the owner (as the migration Job connects), the factory's writer, the console's reader, the scoreboard's
 * writer and the Postgres exporter's reader.
 */
import { inject } from 'vitest';
import { createDatabase } from './postgres.ts';

export type { Database } from './postgres.ts';

/** A fresh database on the Postgres the test project's setup provides. */
export const freshDatabase = (name: string) => createDatabase(inject('databaseUrl'), name);
