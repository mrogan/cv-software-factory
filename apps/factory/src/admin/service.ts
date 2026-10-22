/** Starts the admin service: its store, its full-event streams and its server, and how to stop them. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from '@software-factory/store';
import type { Sql } from 'postgres';
import { log } from '../log.ts';
import { createAdminApp } from './app.ts';
import type { AdminConfig } from './config.ts';
import { AdminStore } from './store.ts';
import { FullEvents, RECHECK_MS } from './stream.ts';

export interface AdminService {
  server: Server;
  events: FullEvents;
  stop(): Promise<void>;
}

/** Listens on the configured port, or on `port` if given (0 for any, in the tests). */
export async function startAdmin(
  config: AdminConfig,
  {
    sql = connect(process.env.DATABASE_URL),
    port = config.port,
    recheckMs = RECHECK_MS,
  }: { sql?: Sql; port?: number; recheckMs?: number } = {},
): Promise<AdminService> {
  const store = new AdminStore(sql);
  const events = new FullEvents(sql, store, log, recheckMs);
  await events.start();
  const server = createServer(createAdminApp({ config, store, events, log }));
  // Slow requests are cut off: nothing here takes long to send.
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const bound = (server.address() as AddressInfo).port;
  log.info({ port: bound, origin: config.origin, rpId: config.rpId }, `admin service listening on :${bound}`);

  const stop = async () => {
    await events.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await sql.end();
  };
  return { server, events, stop };
}
