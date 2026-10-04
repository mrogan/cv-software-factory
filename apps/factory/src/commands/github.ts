/**
 * `factory github`: the GitHub worker, the only pod with the factory's App key, and so the only thing that acts in
 * GitHub as the factory.
 *
 *     factory github run
 *     factory github workflow-refusal [--repo <owner/name>]... [--out <file>]
 *
 * `run` serves the worker's actions to the other workers (`github/server.ts`) and polls GitHub and GHCR. Settings
 * come from the environment (`github/config.ts`); with no key it reads and writes nothing, and with GITHUB_DRY_RUN
 * it records what it would have done in the artifact store.
 *
 * `workflow-refusal` has the App try to add a workflow to each repository (both, by default), which GitHub must
 * refuse, and writes GitHub's answers as JSON to the file (or prints them). It exits 1 if GitHub accepted one.
 */
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { configFromEnv, type GitHubConfig, REPOSITORIES } from '../github/config.ts';

export const USAGE = `  factory github run
  factory github workflow-refusal [--repo <owner/name>]... [--out <file>]`;

export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { repo: { type: 'string', multiple: true, default: [...REPOSITORIES] }, out: { type: 'string' } },
  });
  const [command] = positionals;
  if (command !== 'run' && command !== 'workflow-refusal') {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  let config: GitHubConfig;
  try {
    config = configFromEnv(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 2;
  }
  const { log } = await import('../log.ts');

  if (command === 'workflow-refusal') {
    if (!config.credentials) {
      console.error('This needs the App: set GITHUB_APP_CLIENT_ID and GITHUB_APP_PRIVATE_KEY.');
      return 2;
    }
    const { GitHub } = await import('../github/client.ts');
    const { LiveActions } = await import('../github/actions.ts');
    const { tryWorkflowWrite } = await import('../github/refusal.ts');
    const github = new GitHub({ credentials: config.credentials, api: config.api, log });
    const refusals = [];
    for (const repo of values.repo) {
      const refusal = await tryWorkflowWrite(github, new LiveActions(github), repo);
      console.error(
        refusal.outcome === 'refused'
          ? `${repo}: GitHub took the control commit and refused the workflow (${refusal.message}).`
          : `${repo}: GitHub ACCEPTED the App adding a workflow. The App has a permission it must not have.`,
      );
      refusals.push(refusal);
    }
    const json = `${JSON.stringify(refusals, null, 2)}\n`;
    if (values.out) await writeFile(values.out, json);
    else process.stdout.write(json);
    return refusals.every((r) => r.outcome === 'refused') ? 0 : 1;
  }

  // The instrumentation goes in before the modules it patches are imported.
  const { shutdownTelemetry } = await import('../telemetry.ts');
  const { startGitHubWorker } = await import('../github/service.ts');
  const { stop } = await startGitHubWorker(config, log);
  return new Promise<number>((resolve) => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        log.info({ signal }, 'github worker stopping');
        void Promise.all([stop(), shutdownTelemetry()]).then(
          () => resolve(0),
          () => resolve(1),
        );
      });
    }
  });
}
