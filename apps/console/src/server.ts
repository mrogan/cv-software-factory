/**
 * Starts the console.
 *
 *     node --import ./src/telemetry.ts src/server.ts
 *
 * Where the events come from, in order of preference:
 *
 * - The event store, when PGHOST or DATABASE_URL is set. The console connects as its read-only role, and serves
 *   artifacts from ARTIFACTS_DIR.
 * - An event-log folder, when EVENT_LOG is set: its events and its artifacts, fixed when the server starts, and
 *   moved so the last event is now. EVENT_LOG_NOW sets that "now" instead, so tests can pin the time.
 * - Otherwise nothing: the console shows an empty store.
 *
 * PORT sets the port (default 8080); GIT_COMMIT is the commit the build was made from, set by the image.
 */
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACTS_DIR } from '@software-factory/events';
import { DiskArtifacts } from '@software-factory/store';
import postgres from 'postgres';
import { createApp } from './app.ts';
import { Feed, logFeed, storeFeed } from './feed.ts';
import { log } from './log.ts';
import { loadSite } from './site.ts';
import { shutdownTelemetry } from './telemetry.ts';

const port = Number(process.env.PORT ?? 8080);
const commit = process.env.GIT_COMMIT ?? 'dev';
const { DATABASE_URL, PGHOST, EVENT_LOG, EVENT_LOG_NOW } = process.env;
const logNow = () => (EVENT_LOG_NOW ? Date.parse(EVENT_LOG_NOW) : Date.now());

const options = { onnotice: () => {}, max: 4 };
const sql = DATABASE_URL ? postgres(DATABASE_URL, options) : PGHOST ? postgres(options) : undefined;
const source = sql
  ? { feed: await storeFeed(sql), artifacts: process.env.ARTIFACTS_DIR }
  : EVENT_LOG
    ? { feed: logFeed(EVENT_LOG, logNow()), artifacts: join(EVENT_LOG, ARTIFACTS_DIR) }
    : { feed: new Feed(), artifacts: undefined };
if (!sql && !EVENT_LOG) log.warn('no event store or event log configured: the console will show an empty store');

const server = createServer(
  createApp({
    commit,
    site: loadSite(),
    feed: source.feed,
    artifacts: new DiskArtifacts(source.artifacts ?? mkdtempSync(join(tmpdir(), 'no-artifacts-'))),
  }),
);
server.listen(port, () => log.info({ port, commit }, `console listening on :${port}`));

// Kubernetes sends SIGTERM before it stops the pod: finish the requests in flight, then flush telemetry.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'console stopping');
    server.close(() => void Promise.all([sql?.end(), shutdownTelemetry()]).finally(() => process.exit(0)));
    // Event streams never finish on their own.
    server.closeAllConnections();
  });
}
