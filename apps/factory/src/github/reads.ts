/**
 * What the other workers may read from GitHub through the worker: a pull request's state, the check runs on a commit,
 * the checks a branch's ruleset requires, a branch's head, the paths no patch may change at a commit, and how a
 * commit compares with a branch. The line reads them to see its pull requests through their gates and to Martin's
 * merge, and appends what it sees as events; holds a spec's scope to the protected paths; and gives the reviewer the
 * base its change is measured from, and anchors its findings to lines the change shows. The worker itself touches no
 * store.
 *
 * Every read is a conditional request, so asking again about something that has not changed costs nothing against
 * the rate limit, and every answer is read through a Zod schema. Reading is harmless, so a dry run reads as a live
 * worker does; and a worker with no key reads the public repositories as anyone may.
 */
import { z } from 'zod';
import { type GitHub, GitHubError } from './client.ts';
import { CODEOWNERS_PATHS, protectedFrom } from './paths.ts';

export interface PullRequestState {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  /** The squash commit on the base, once merged. */
  mergeCommit: string | null;
  /** Who merged it, by login. */
  mergedBy: string | null;
  head: { ref: string; sha: string };
  /** The branch it merges into, and that branch's commit its diff is taken against. */
  base: { ref: string; sha: string };
  draft: boolean;
  /** GraphQL's id, which readying a draft needs. */
  nodeId: string;
}

export interface CheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** The app that reported it, such as `github-actions` or the factory's own. */
  app: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** The check's own one-line title, when it gave one. */
  title: string | null;
}

/** A commit compared with a branch, as a pull request's diff is taken. */
export interface Comparison {
  /** Where the commit's history left the branch's: what the change is measured from. */
  mergeBase: string;
  /**
   * Each file the commit changes since then, with its patch as GitHub shows it: none for a binary file, or one too
   * large to show.
   */
  files: { path: string; patch: string | null }[];
}

export interface Reads {
  pullRequest(repo: string, number: number): Promise<PullRequestState>;
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  /** The status checks a branch's rulesets require, by name. */
  requiredChecks(repo: string, branch: string): Promise<string[]>;
  /** The commit a branch points at. */
  head(repo: string, branch: string): Promise<string>;
  /** The open pull request from one of the repository's branches, if there is one. */
  pullRequestFrom(repo: string, branch: string): Promise<PullRequestState | null>;
  /**
   * The paths no patch may change at a commit, as scope entries: the workflows, the deployment, and what the
   * repository's CODEOWNERS gives a person (`paths.ts`, as the worker's guard reads them).
   */
  protectedPaths(repo: string, ref: string): Promise<string[]>;
  /** How a commit compares with a branch: its merge base, and the files it changes since. */
  comparison(repo: string, base: string, head: string): Promise<Comparison>;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);

const PULL = z.object({
  number: z.number().int().positive(),
  state: z.enum(['open', 'closed']),
  merged: z.boolean(),
  merge_commit_sha: SHA.nullable(),
  // GitHub gives a deleted account as null.
  merged_by: z.object({ login: z.string() }).nullable(),
  head: z.object({ ref: z.string(), sha: SHA }),
  base: z.object({ ref: z.string(), sha: SHA }),
  draft: z.boolean().optional(),
  node_id: z.string().min(1),
});

const CHECK_RUNS = z.object({
  check_runs: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      app: z.object({ slug: z.string().optional() }).nullable().optional(),
      started_at: z.string().nullable().optional(),
      completed_at: z.string().nullable().optional(),
      output: z.object({ title: z.string().nullable().optional() }).optional(),
    }),
  ),
});

const RULES = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() })
      .loose()
      .optional(),
  }),
);

const REF = z.object({ object: z.object({ sha: SHA }) });

/** What the contents API answers for a path: a file, or a folder's listing. */
const CONTENTS = z.union([
  z.object({ type: z.string(), encoding: z.string().optional(), content: z.string().optional() }),
  z.array(z.unknown()),
]);

const pullRequestState = (pr: z.infer<typeof PULL>): PullRequestState => ({
  number: pr.number,
  state: pr.state,
  merged: pr.merged,
  mergeCommit: pr.merged ? pr.merge_commit_sha : null,
  mergedBy: pr.merged_by?.login ?? null,
  head: { ref: pr.head.ref, sha: pr.head.sha },
  base: { ref: pr.base.ref, sha: pr.base.sha },
  draft: pr.draft ?? false,
  nodeId: pr.node_id,
});

const COMPARE = z.object({
  merge_base_commit: z.object({ sha: SHA }),
  files: z.array(z.object({ filename: z.string(), patch: z.string().optional() })).optional(),
});

const segments = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export class LiveReads implements Reads {
  readonly #github: GitHub;

  constructor(github: GitHub) {
    this.#github = github;
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestState> {
    const { body: pr } = await this.#github.poll(repo, `/repos/${repo}/pulls/${number}`, PULL);
    return pullRequestState(pr);
  }

  async pullRequestFrom(repo: string, branch: string): Promise<PullRequestState | null> {
    const head = `${repo.split('/')[0]}:${branch}`;
    const path = `/repos/${repo}/pulls?head=${encodeURIComponent(head)}&state=open&per_page=1`;
    const { body } = await this.#github.poll(repo, path, z.array(PULL));
    return body[0] ? pullRequestState(body[0]) : null;
  }

  async checkRuns(repo: string, sha: string): Promise<CheckRun[]> {
    // One page: a commit here has a dozen check runs, not a hundred.
    const { body } = await this.#github.poll(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`, CHECK_RUNS);
    return body.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      app: run.app?.slug ?? null,
      startedAt: run.started_at ?? null,
      completedAt: run.completed_at ?? null,
      title: run.output?.title ?? null,
    }));
  }

  async requiredChecks(repo: string, branch: string): Promise<string[]> {
    const { body } = await this.#github.poll(repo, `/repos/${repo}/rules/branches/${segments(branch)}`, RULES);
    const names = body
      .filter((rule) => rule.type === 'required_status_checks')
      .flatMap((rule) => rule.parameters?.required_status_checks?.map((check) => check.context) ?? []);
    return [...new Set(names)];
  }

  async head(repo: string, branch: string): Promise<string> {
    const { body } = await this.#github.poll(repo, `/repos/${repo}/git/ref/heads/${segments(branch)}`, REF);
    return body.object.sha;
  }

  async protectedPaths(repo: string, ref: string): Promise<string[]> {
    const files = await Promise.all(CODEOWNERS_PATHS.map((path) => this.#text(repo, path, ref)));
    return protectedFrom(files.find((text) => text !== null) ?? null);
  }

  /** A text file at a commit, or null where there is none: no such path, a folder, or a file the API will not send. */
  async #text(repo: string, path: string, ref: string): Promise<string | null> {
    const url = `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`;
    try {
      const { body } = await this.#github.poll(repo, url, CONTENTS);
      if (Array.isArray(body) || body.type !== 'file' || body.encoding !== 'base64' || body.content === undefined)
        return null;
      return Buffer.from(body.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GitHubError && error.kind === 'not-found') return null;
      throw error;
    }
  }

  async comparison(repo: string, base: string, head: string): Promise<Comparison> {
    // One page of files: a fix's scope names a few, and GitHub lists up to 300 on its first.
    const { body } = await this.#github.poll(
      repo,
      `/repos/${repo}/compare/${segments(base)}...${head}?per_page=100`,
      COMPARE,
    );
    return {
      mergeBase: body.merge_base_commit.sha,
      files: (body.files ?? []).map((file) => ({ path: file.filename, patch: file.patch ?? null })),
    };
  }
}
