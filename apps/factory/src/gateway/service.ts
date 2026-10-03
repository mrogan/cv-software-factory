/**
 * Starts the gateway: the store, the spend ledger, the cassettes, the provider and the HTTP server, wired from a
 * `GatewayConfig`. `factory gateway` is the entry point, and loads `telemetry.ts` before this module.
 */
import { tmpdir } from 'node:os';
import { DiskArtifacts, EventWriter } from '@software-factory/store';
import postgres from 'postgres';
import { SPEND } from '../../../../policy/spend.ts';
import { Cassettes } from './cassettes.ts';
import type { GatewayConfig } from './config.ts';
import { Gateway } from './gateway.ts';
import { log } from './log.ts';
import { createGatewayServer } from './server.ts';
import { Spend } from './spend.ts';
import { TypeSafe } from './typesafe.ts';

export async function startGateway(config: GatewayConfig, env: NodeJS.ProcessEnv = process.env) {
  const options = { onnotice: () => {}, max: 4 };
  const sql = env.DATABASE_URL ? postgres(env.DATABASE_URL, options) : postgres(options);
  // The line events the gateway appends have no artifacts, so the store it is given is never read.
  const events = new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(tmpdir()) });
  const spend = new Spend({ sql, events, profile: config.profile, policy: SPEND[config.profile], log });
  const typesafe = config.apiKey
    ? new TypeSafe({ apiKey: config.apiKey, log, ...(config.typesafeUrl ? { baseUrl: config.typesafeUrl } : {}) })
    : undefined;
  const gateway = new Gateway({
    sql,
    spend,
    cassettes: new Cassettes({ record: config.cassettesDir, read: config.cassettesRead }),
    mode: config.mode,
    typesafe,
    log,
  });
  await spend.resume();
  spend.start();

  const server = createGatewayServer({ gateway, spend, log });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  log.info({ port: config.port, mode: gateway.mode, profile: config.profile }, `gateway listening on :${config.port}`);

  /** Finishes the requests in flight, then lets go of the store. */
  const stop = async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await spend.stop();
    await sql.end();
  };
  return { server, stop };
}
