/**
 * Starts the console.
 *
 *     node --import ./src/telemetry.ts src/server.ts
 *
 * PORT sets the port (default 8080); GIT_COMMIT is the commit the build was made from, set by the image.
 */
import { createServer } from 'node:http';
import { createApp } from './app.ts';
import { loadAssets } from './assets.ts';
import { log } from './log.ts';
import { shutdownTelemetry } from './telemetry.ts';

const port = Number(process.env.PORT ?? 8080);
const commit = process.env.GIT_COMMIT ?? 'dev';

const server = createServer(createApp({ commit, assets: loadAssets(commit) }));
server.listen(port, () => log.info({ port, commit }, `console listening on :${port}`));

// Kubernetes sends SIGTERM before it stops the pod: finish the requests in flight, then flush telemetry.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'console stopping');
    server.close(() => void shutdownTelemetry().finally(() => process.exit(0)));
    server.closeIdleConnections();
  });
}
