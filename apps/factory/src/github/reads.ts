/**
 * What the other workers may read from GitHub through the worker: a pull request's state, the check runs on a commit,
 * the checks a branch's ruleset requires, and a branch's head. The line reads them to see its pull requests through
 * their gates and to Martin's merge, and appends what it sees as events; the worker itself touches no store.
 *
 * Every read is a conditional request, so asking again about something that has not changed costs nothing against
 * the rate limit, and every answer is read through a Zod schema. Reading is harmless, so a dry run reads as a live
 * worker does; and a worker with no key reads the public repositories as anyone may.
 */
import { z } from 'zod';
import type { GitHub } from './client.ts';

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

export interface Reads {
  pullRequest(repo: string, number: number): Promise<PullRequestState>;
  checkRuns(repo: string, sha: string): Promise<CheckRun[]>;
  /** The status checks a branch's rulesets require, by name. */
  requiredChecks(repo: string, branch: string): Promise<string[]>;
  /** The commit a branch points at. */
  head(repo: string, branch: string): Promise<string>;
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

const segments = (branch: string) => branch.split('/').map(encodeURIComponent).join('/');

export class LiveReads implements Reads {
  readonly #github: GitHub;

  constructor(github: GitHub) {
    this.#github = github;
  }

  async pullRequest(repo: string, number: number): Promise<PullRequestState> {
    const { body: pr } = await this.#github.poll(repo, `/repos/${repo}/pulls/${number}`, PULL);
    return {
      number: pr.number,
      state: pr.state,
      merged: pr.merged,
      mergeCommit: pr.merged ? pr.merge_commit_sha : null,
      mergedBy: pr.merged_by?.login ?? null,
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
      draft: pr.draft ?? false,
      nodeId: pr.node_id,
    };
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
}
