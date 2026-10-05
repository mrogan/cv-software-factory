/**
 * The GitHub worker, as the other workers call it (`github/server.ts`). Every action in GitHub goes through it: it
 * holds the App's key, and nothing else does. Reads go through it too (`reads.ts`), so it is the one place that
 * talks to GitHub.
 */
import type { Reads } from './reads.ts';

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

  get dryRun(): boolean {
    return this.#dryRun;
  }

  async act<T>(action: string, repo: string, args: Record<string, unknown>): Promise<T> {
    return this.#post<T>(`actions/${action}`, repo, args, this.#dryRun ? { 'x-factory-dry-run': 'true' } : {});
  }

  /** Reads from GitHub. A read is the same in a dry run: it changes nothing. */
  async read<K extends keyof Reads>(
    read: K,
    repo: string,
    args: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<Reads[K]>>> {
    return this.#post<Awaited<ReturnType<Reads[K]>>>(`reads/${read}`, repo, args, {});
  }

  async #post<T>(
    path: string,
    repo: string,
    args: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<T> {
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
