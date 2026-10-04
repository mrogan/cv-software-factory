/**
 * Starts the GitHub worker: the client with the App's key, the actions (live or a dry run), the poller and the HTTP
 * server, wired from a `GitHubConfig`. `factory github` is the entry point, and loads `telemetry.ts` before this module.
 */
import { DiskArtifacts } from '@software-factory/store';
import type { Logger } from 'pino';
import { type Actions, DryRunActions, LiveActions } from './actions.ts';
import { GitHub } from './client.ts';
import type { GitHubConfig } from './config.ts';
import { Poller } from './poller.ts';
import { Registry } from './registry.ts';
import { createWorkerServer } from './server.ts';

export async function startGitHubWorker(config: GitHubConfig, log: Logger) {
  const github = new GitHub({ credentials: config.credentials, api: config.api, log });
  const registry = new Registry({ base: config.ghcr });
  const actions: Actions =
    config.dryRun && config.artifactsDir
      ? new DryRunActions(new DiskArtifacts(config.artifactsDir), log)
      : new LiveActions(github);
  const poller = new Poller({ intervalMs: config.pollMs, log });

  const mode = config.dryRun ? 'dry-run' : github.writable ? 'live' : 'read-only';
  if (mode === 'read-only') {
    log.warn('No App key (GITHUB_APP_PRIVATE_KEY): the worker reads GitHub and writes nothing.');
  }
  const server = createWorkerServer({
    actions,
    repositories: config.repositories,
    health: () => ({ mode, watching: poller.watching }),
    log,
  });
  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  poller.start();
  log.info(
    { port: config.port, mode, repositories: config.repositories },
    `github worker listening on :${config.port}`,
  );

  const stop = async () => {
    await poller.stop();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  };
  return { github, registry, actions, poller, server, mode, stop };
}
