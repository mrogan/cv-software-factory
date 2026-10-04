/**
 * The GitHub worker's settings, read from the environment.
 *
 *     GITHUB_APP_CLIENT_ID     the App's Client ID; with the key, the worker acts as the App
 *     GITHUB_APP_PRIVATE_KEY   the App's private key, as PEM. Without it the worker reads, writes nothing, and says so
 *     GITHUB_DRY_RUN           true: write nothing to GitHub, and record each action in the artifact store instead
 *     ARTIFACTS_DIR            the artifact store, for a dry run's records
 *     GITHUB_REPOSITORIES      the repositories it acts on, separated by commas (default: both public ones)
 *     GITHUB_POLL_SECONDS      how often it polls (default 60)
 *     GITHUB_API_URL, GHCR_URL GitHub's API and GHCR, for a stand-in
 *     PORT                     default 8080
 */
import type { AppCredentials } from './app.ts';
import { API } from './client.ts';
import { GHCR } from './registry.ts';

/** The two public repositories: the factory's own, and the app it looks after. */
export const REPOSITORIES = ['mrogan/cv-software-factory', 'mrogan/cv-worlds-worst-website'] as const;

export interface GitHubConfig {
  credentials: AppCredentials | undefined;
  dryRun: boolean;
  artifactsDir: string | undefined;
  repositories: string[];
  pollMs: number;
  api: string;
  ghcr: string;
  port: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv): GitHubConfig {
  const clientId = env.GITHUB_APP_CLIENT_ID || undefined;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY || undefined;
  if (privateKey && !clientId) throw new Error('GITHUB_APP_PRIVATE_KEY is set without GITHUB_APP_CLIENT_ID.');
  const dryRun = env.GITHUB_DRY_RUN === 'true' || env.GITHUB_DRY_RUN === '1';
  const config: GitHubConfig = {
    credentials: clientId && privateKey ? { clientId, privateKey } : undefined,
    dryRun,
    artifactsDir: env.ARTIFACTS_DIR || undefined,
    repositories: (env.GITHUB_REPOSITORIES || REPOSITORIES.join(','))
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean),
    pollMs: Number(env.GITHUB_POLL_SECONDS || 60) * 1000,
    api: env.GITHUB_API_URL || API,
    ghcr: env.GHCR_URL || GHCR,
    port: Number(env.PORT ?? 8080),
  };
  if (dryRun && !config.artifactsDir)
    throw new Error('GITHUB_DRY_RUN records to the artifact store: set ARTIFACTS_DIR.');
  for (const repo of config.repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`GITHUB_REPOSITORIES has ${JSON.stringify(repo)}, not owner/name.`);
  }
  if (!(config.pollMs >= 10_000)) throw new Error('GITHUB_POLL_SECONDS must be at least 10.');
  return config;
}
