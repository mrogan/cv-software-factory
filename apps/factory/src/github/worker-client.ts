/**
 * The GitHub worker, as the other workers call it (`github/server.ts`). Every action in GitHub goes through it: it
 * holds the App's key, and nothing else does. Reads go through it too (`reads.ts`), so it is the one place that
 * talks to GitHub.
 */
import type { ActionArgs, ActionName, ActionResult, ReadArgs, ReadName, ReadResult } from './server.ts';

export class GitHubWorkerError extends Error {
  readonly status: number;
  readonly kind: string;

  constructor(status: number, kind: string, message: string) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

export class GitHubWorker {
  readonly #url: string;
  readonly #dryRun: boolean;

  /** With `dryRun`, every action is recorded by the worker and none is done. */
  constructor(url: string, { dryRun = false } = {}) {
    this.#url = url.replace(/\/$/, '');
    this.#dryRun = dryRun;
  }

  async act<K extends ActionName>(action: K, repo: string, args: ActionArgs[K]): Promise<ActionResult<K>> {
    return this.#post(`actions/${action}`, repo, args, this.#dryRun ? { 'x-factory-dry-run': 'true' } : {});
  }

  /** Reads from GitHub. A read is the same in a dry run: it changes nothing. */
  async read<K extends ReadName>(read: K, repo: string, args: ReadArgs[K]): Promise<ReadResult<K>> {
    return this.#post(`reads/${read}`, repo, args, {});
  }

  async #post<T>(path: string, repo: string, args: object, headers: Record<string, string>): Promise<T> {
    const response = await fetch(`${this.#url}/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ repo, ...args }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json()) as { result?: T; error?: string; message?: string };
    if (!response.ok)
      throw new GitHubWorkerError(response.status, body.error ?? 'unknown', body.message ?? `${path} failed`);
    return body.result as T;
  }
}
