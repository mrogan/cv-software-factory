/**
 * The GitHub worker, as the other workers call it (`github/server.ts`). Every action in GitHub goes through it: it
 * holds the App's key, and nothing else does.
 */
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

  async act<T>(action: string, repo: string, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.#url}/v1/actions/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.#dryRun ? { 'x-factory-dry-run': 'true' } : {}) },
      body: JSON.stringify({ repo, ...args }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json()) as { result?: T; error?: string; message?: string };
    if (!response.ok)
      throw new GitHubWorkerError(response.status, body.error ?? 'unknown', body.message ?? `${action} failed`);
    return body.result as T;
  }
}
