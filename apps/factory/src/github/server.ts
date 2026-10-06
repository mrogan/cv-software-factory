/**
 * The GitHub worker over HTTP, for the other workers in the cluster: the only way they act in GitHub, since this is
 * the only pod with the App's key.
 *
 *     POST /v1/actions/<action>   one of `Actions`, with its arguments as JSON; its result out. With the header
 *                                 `x-factory-dry-run: true` it is recorded in the artifact store and not done
 *     POST /v1/reads/<read>       one of `Reads` (`reads.ts`), with its arguments as JSON; what GitHub says out
 *     GET  /health                whether it can write, whether it is a dry run, and what it is watching
 *
 * A body must say it is JSON: a web page cannot send that without the browser asking first, and the worker answers
 * no browser, so a page open on the same machine cannot make it act. Each body is checked with Zod at the door, and names a repository the worker is configured for, or it is refused.
 * A GitHub failure keeps its meaning: refused 403, not found 404, conflict 409, rate limited 429, GitHub or the
 * network failing 502, and a write with no key 503. A patch that will not apply, or a branch the factory does not
 * own, is 422.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Actions } from './actions.ts';
import { BranchRefused } from './branches.ts';
import { GitHubError } from './client.ts';
import { PatchRefused } from './patches.ts';
import type { Reads } from './reads.ts';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const branch = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*\/$|.*\.\.|.*\/\/)[A-Za-z0-9._/-]+$/, 'a branch name of letters, digits, dots, dashes and slashes');
const path = z
  .string()
  .min(1)
  .max(400)
  .refine((p) => !p.startsWith('/') && !p.split('/').some((part) => part === '..' || part === ''), 'a relative path');
const number = z.number().int().positive();
const text = (max: number) => z.string().max(max);
const pullRequestRef = z.strictObject({ number, url: z.string(), nodeId: z.string().min(1) });
const checkRun = z.strictObject({
  name: text(100).min(1),
  headSha: sha,
  status: z.enum(['queued', 'in_progress', 'completed']),
  conclusion: z
    .enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'])
    .optional(),
  title: text(200),
  summary: text(65_535),
  text: text(65_535).optional(),
  detailsUrl: z.url().optional(),
  externalId: text(100).optional(),
});

/** Each action's arguments after the repository, as the endpoint takes them. */
const ARGS = {
  setBranch: z.strictObject({ branch, sha, force: z.boolean().optional() }),
  deleteBranch: z.strictObject({ branch }),
  commit: z.strictObject({
    branch,
    expectedHead: sha,
    message: text(10_000).min(1),
    changes: z.strictObject({
      additions: z.array(z.strictObject({ path, contents: z.base64() })).max(200),
      deletions: z.array(path).max(200),
    }),
  }),
  applyPatch: z.strictObject({
    branch,
    expectedHead: sha,
    patch: z
      .string()
      .min(1)
      .max(2 * 1024 * 1024),
    message: text(10_000).min(1),
  }),
  openPullRequest: z.strictObject({
    head: branch,
    base: branch,
    title: text(256).min(1),
    body: text(65_535),
    draft: z.boolean().optional(),
    labels: z.array(text(50)).max(10).optional(),
  }),
  updatePullRequest: z.strictObject({ number, title: text(256).min(1).optional(), body: text(65_535).optional() }),
  addLabels: z.strictObject({ number, labels: z.array(text(50)).min(1).max(10) }),
  readyForReview: z.strictObject({ pullRequest: pullRequestRef }),
  updateBranch: z.strictObject({ number, expectedHead: sha }),
  review: z.strictObject({
    number,
    commit: sha,
    body: text(65_535),
    comments: z.array(z.strictObject({ path, line: number, body: text(65_535).min(1) })).max(50),
  }),
  createCheckRun: checkRun,
  updateCheckRun: z.strictObject({ id: number, ...checkRun.partial().shape }),
  openIssue: z.strictObject({
    title: text(256).min(1),
    body: text(65_535),
    labels: z.array(text(50)).max(10).optional(),
  }),
  closeIssue: z.strictObject({ number, reason: z.enum(['completed', 'not_planned']) }),
  comment: z.strictObject({ number, body: text(65_535).min(1) }),
} satisfies Record<keyof Omit<Actions, 'dryRun'>, z.ZodType>;

type Name = keyof typeof ARGS;

/** The actions a worker may ask for, each with its arguments after the repository, and what it gives back. */
export type ActionName = Name;
export type ActionArgs = { [K in Name]: z.input<(typeof ARGS)[K]> };
export type ActionResult<K extends Name> = Awaited<ReturnType<Actions[K]>>;

/** Each action's call, from its checked arguments. */
const CALLS: { [K in Name]: (actions: Actions, repo: string, args: z.infer<(typeof ARGS)[K]>) => Promise<unknown> } = {
  setBranch: (x, repo, { branch, sha, force }) => x.setBranch(repo, branch, sha, force === undefined ? {} : { force }),
  deleteBranch: (x, repo, { branch }) => x.deleteBranch(repo, branch),
  commit: (x, repo, { changes, ...commit }) =>
    x.commit(repo, {
      ...commit,
      changes: {
        additions: changes.additions.map((f) => ({ path: f.path, contents: Buffer.from(f.contents, 'base64') })),
        deletions: changes.deletions,
      },
    }),
  applyPatch: (x, repo, patch) => x.applyPatch(repo, patch),
  openPullRequest: (x, repo, draft) => x.openPullRequest(repo, defined(draft)),
  updatePullRequest: (x, repo, { number, ...change }) => x.updatePullRequest(repo, number, defined(change)),
  addLabels: (x, repo, { number, labels }) => x.addLabels(repo, number, labels),
  readyForReview: (x, repo, { pullRequest }) => x.readyForReview(repo, pullRequest),
  updateBranch: (x, repo, { number, expectedHead }) => x.updateBranch(repo, number, expectedHead),
  review: (x, repo, { number, ...review }) => x.review(repo, number, review),
  createCheckRun: (x, repo, report) => x.createCheckRun(repo, defined(report)),
  updateCheckRun: (x, repo, { id, ...report }) => x.updateCheckRun(repo, id, defined(report)),
  openIssue: (x, repo, issue) => x.openIssue(repo, defined(issue)),
  closeIssue: (x, repo, { number, reason }) => x.closeIssue(repo, number, reason),
  comment: (x, repo, { number, body }) => x.comment(repo, number, body),
};

/** Each read's arguments after the repository. */
const READS = {
  pullRequest: z.strictObject({ number }),
  checkRuns: z.strictObject({ sha }),
  requiredChecks: z.strictObject({ branch }),
  head: z.strictObject({ branch }),
  pullRequestFrom: z.strictObject({ branch }),
} satisfies Record<keyof Reads, z.ZodType>;

type ReadName = keyof typeof READS;

/** The reads a worker may ask for, each with its arguments after the repository, and what it gives back. */
export type { ReadName };
export type ReadArgs = { [K in ReadName]: z.input<(typeof READS)[K]> };
export type ReadResult<K extends ReadName> = Awaited<ReturnType<Reads[K]>>;

const READ_CALLS: {
  [K in ReadName]: (reads: Reads, repo: string, args: z.infer<(typeof READS)[K]>) => Promise<unknown>;
} = {
  pullRequest: (r, repo, { number }) => r.pullRequest(repo, number),
  checkRuns: (r, repo, { sha }) => r.checkRuns(repo, sha),
  requiredChecks: (r, repo, { branch }) => r.requiredChecks(repo, branch),
  head: (r, repo, { branch }) => r.head(repo, branch),
  pullRequestFrom: (r, repo, { branch }) => r.pullRequestFrom(repo, branch),
};

/** An object without its undefined fields, as the actions' optional fields expect: absent, never undefined. */
function defined<T extends object>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never;
}

class TooLarge extends Error {}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_BODY_BYTES) chunks.push(chunk);
  }
  if (size > MAX_BODY_BYTES) throw new TooLarge();
  return Buffer.concat(chunks).toString('utf-8');
}

const STATUS: Record<GitHubError['kind'], number> = {
  refused: 403,
  'not-found': 404,
  conflict: 409,
  'rate-limited': 429,
  server: 502,
  network: 502,
  'read-only': 503,
  malformed: 502,
};

export interface WorkerServerOptions {
  actions: Actions;
  /** What the other workers may read; without it, every read is not found. */
  reads?: Reads | undefined;
  /** What a request asking for a dry run (`x-factory-dry-run: true`) gets: one memory of what it would have done. */
  dryRun?: Actions | undefined;
  /** The repositories the worker acts on, as `owner/name`. */
  repositories: readonly string[];
  /** What the worker says about itself at `/health`. */
  health: () => Record<string, unknown>;
  log: Logger;
}

export function createWorkerServer({
  actions: live,
  reads,
  dryRun,
  repositories,
  health,
  log,
}: WorkerServerOptions): Server {
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', 'http://github');
    if (pathname === '/health') return send(res, 200, { status: 'ok', ...health() });
    // A dry run when asked for, such as the smoke run's, even from a worker that acts.
    const actions = req.headers['x-factory-dry-run'] === 'true' && dryRun ? dryRun : live;
    const [, kind, name = ''] = /^\/v1\/(actions|reads)\/([A-Za-z]+)$/.exec(pathname) ?? [];
    const known =
      kind === 'actions' ? Object.hasOwn(ARGS, name) : kind === 'reads' && reads && Object.hasOwn(READS, name);
    if (!known)
      return send(res, 404, { error: 'not-found', message: `No such ${kind === 'reads' ? 'read' : 'action'}.` });
    if (req.method !== 'POST') return send(res, 405, { error: 'bad-request', message: 'Use POST.' });
    if (!/^application\/json(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return send(res, 415, { error: 'bad-request', message: 'Send the body as application/json.' });
    }

    let input: unknown;
    try {
      input = JSON.parse(await readBody(req));
    } catch (error) {
      const message = error instanceof TooLarge ? `The body is over ${MAX_BODY_BYTES} bytes.` : 'The body is not JSON.';
      return send(res, error instanceof TooLarge ? 413 : 400, { error: 'bad-request', message });
    }
    const { repo, ...rest } = (input ?? {}) as { repo?: unknown };
    if (typeof repo !== 'string' || !repositories.includes(repo)) {
      return send(res, 400, { error: 'bad-request', message: `repo must be one of ${repositories.join(', ')}.` });
    }
    const parsed = (kind === 'reads' ? READS[name as ReadName] : ARGS[name as Name]).safeParse(rest);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`);
      return send(res, 400, { error: 'bad-request', message: problems.join('; ') });
    }
    if (kind === 'reads' && reads) {
      const read = READ_CALLS[name as ReadName] as (r: Reads, repo: string, args: unknown) => Promise<unknown>;
      return send(res, 200, { result: await read(reads, repo, parsed.data) });
    }
    const result = await (CALLS[name as Name] as (x: Actions, r: string, a: unknown) => Promise<unknown>)(
      actions,
      repo,
      parsed.data,
    );
    log.info({ action: name, repo, dryRun: actions.dryRun }, `github ${name}`);
    send(res, 200, { result: result ?? null, dryRun: actions.dryRun });
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (error instanceof PatchRefused) {
        log.warn({ message: error.message }, 'a patch was refused');
        return send(res, 422, { error: 'patch-refused', message: error.message });
      }
      if (error instanceof BranchRefused) {
        log.warn({ message: error.message }, 'a branch was refused');
        return send(res, 422, { error: 'branch-refused', message: error.message });
      }
      if (error instanceof GitHubError) {
        log.warn({ kind: error.kind, status: error.status, message: error.message }, 'github refused an action');
        return send(res, STATUS[error.kind], { error: error.kind, message: error.message });
      }
      log.error({ err: { type: (error as Error)?.name, message: (error as Error)?.message } }, 'action failed');
      send(res, 500, { error: 'internal', message: 'The action failed; the worker logged why.' });
    });
  });
}
