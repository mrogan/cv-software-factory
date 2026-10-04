/**
 * Everything the factory does in GitHub, as the App: branches, signed commits, pull requests, comment reviews,
 * check runs and issues. Two implementations share the interface:
 *
 * - `LiveActions` does it, through the client.
 * - `DryRunActions` does nothing in GitHub. It writes each action it would have taken to the artifact store, as
 *   JSON with the files a commit would have held, and logs the artifact's hash. The unattended passes run with it,
 *   so a night on the local model leaves a record and no trace in either repository.
 *
 * Commits go through GraphQL's `createCommitOnBranch`, never `git push`: GitHub makes the commit and signs it as the
 * App, which `main`'s ruleset requires, and the factory never runs git in a working tree it does not control.
 */
import type { ArtifactStore } from '@software-factory/store';
import type { Logger } from 'pino';
import { z } from 'zod';
import { type GitHub, GitHubError } from './client.ts';

export interface FileChanges {
  /** Files to add or replace, with their whole new contents. */
  additions: { path: string; contents: Uint8Array }[];
  deletions: string[];
}

export interface Commit {
  branch: string;
  /** The branch's head the commit is made on. GitHub refuses the commit if the branch has moved since. */
  expectedHead: string;
  /** The first line is the headline; the rest, after a blank line, is the body. */
  message: string;
  changes: FileChanges;
}

export interface PullRequestDraft {
  head: string;
  base: string;
  title: string;
  body: string;
  draft?: boolean;
  labels?: string[];
}

export interface PullRequestRef {
  number: number;
  url: string;
  /** GraphQL's id, which readying a draft needs. */
  nodeId: string;
}

export interface ReviewComment {
  path: string;
  /** The line in the change's version of the file (the right-hand side of the diff). */
  line: number;
  body: string;
}

export interface CheckRunReport {
  name: string;
  headSha: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion?: 'success' | 'failure' | 'neutral' | 'cancelled' | 'skipped' | 'timed_out' | 'action_required';
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
  /** The factory's own id for what the check is about, such as a work item, so a later poll can match it. */
  externalId?: string;
}

export interface Actions {
  readonly dryRun: boolean;
  /** Points a branch at a commit, making it if it does not exist. `force` lets it move to a commit that is not a descendant. */
  setBranch(repo: string, branch: string, sha: string, options?: { force?: boolean }): Promise<void>;
  deleteBranch(repo: string, branch: string): Promise<void>;
  /** Makes one signed commit on a branch, and returns its sha. */
  commit(repo: string, commit: Commit): Promise<string>;
  openPullRequest(repo: string, draft: PullRequestDraft): Promise<PullRequestRef>;
  updatePullRequest(repo: string, number: number, change: { title?: string; body?: string }): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  /** Marks a draft pull request ready for review. */
  readyForReview(repo: string, pullRequest: PullRequestRef): Promise<void>;
  /** Merges the base into a pull request's branch, as GitHub's "Update branch" does, if the head is still `expectedHead`. */
  updateBranch(repo: string, number: number, expectedHead: string): Promise<void>;
  /** A comment review: it neither approves nor requests changes, so it never counts toward a merge. */
  review(
    repo: string,
    number: number,
    review: { commit: string; body: string; comments: ReviewComment[] },
  ): Promise<number>;
  createCheckRun(repo: string, report: CheckRunReport): Promise<number>;
  updateCheckRun(repo: string, id: number, report: Partial<CheckRunReport>): Promise<void>;
  openIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<number>;
  closeIssue(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void>;
  comment(repo: string, number: number, body: string): Promise<void>;
}

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const NUMBER = z.number().int().positive();
const ID = z.object({ id: NUMBER });

const CREATE_COMMIT = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`;

const READY = `mutation($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } }
}`;

const checkRunBody = (report: Partial<CheckRunReport>) => ({
  name: report.name,
  head_sha: report.headSha,
  status: report.status,
  conclusion: report.conclusion,
  details_url: report.detailsUrl,
  external_id: report.externalId,
  output:
    report.title === undefined
      ? undefined
      : { title: report.title, summary: report.summary ?? '', ...(report.text ? { text: report.text } : {}) },
});

export class LiveActions implements Actions {
  readonly dryRun = false;
  readonly #github: GitHub;

  constructor(github: GitHub) {
    this.#github = github;
  }

  async setBranch(repo: string, branch: string, sha: string, { force = false } = {}): Promise<void> {
    // Whether the branch is there decides between moving it and making it: asked, not read off an error's words.
    let exists = true;
    try {
      await this.#github.read(repo, `/repos/${repo}/git/ref/heads/${branch}`, z.unknown());
    } catch (error) {
      if (!(error instanceof GitHubError && error.kind === 'not-found')) throw error;
      exists = false;
    }
    if (exists) await this.#github.write(repo, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha, force });
    else await this.#github.write(repo, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.#github.write(repo, 'DELETE', `/repos/${repo}/git/refs/heads/${branch}`);
  }

  async commit(repo: string, { branch, expectedHead, message, changes }: Commit): Promise<string> {
    const [headline = '', ...rest] = message.split('\n');
    const body = rest.join('\n').trim();
    const answer = await this.#github.graphql(
      repo,
      CREATE_COMMIT,
      {
        input: {
          branch: { repositoryNameWithOwner: repo, branchName: branch },
          expectedHeadOid: expectedHead,
          message: { headline, ...(body ? { body } : {}) },
          fileChanges: {
            additions: changes.additions.map((a) => ({
              path: a.path,
              contents: Buffer.from(a.contents).toString('base64'),
            })),
            deletions: changes.deletions.map((path) => ({ path })),
          },
        },
      },
      z.object({ createCommitOnBranch: z.object({ commit: z.object({ oid: SHA }) }) }),
    );
    return answer.createCommitOnBranch.commit.oid;
  }

  async openPullRequest(repo: string, { labels, ...draft }: PullRequestDraft): Promise<PullRequestRef> {
    const made = await this.#github.write(
      repo,
      'POST',
      `/repos/${repo}/pulls`,
      { ...draft, draft: draft.draft ?? false },
      z.object({ number: NUMBER, html_url: z.string(), node_id: z.string().min(1) }),
    );
    if (labels?.length) await this.addLabels(repo, made.number, labels);
    return { number: made.number, url: made.html_url, nodeId: made.node_id };
  }

  async updatePullRequest(repo: string, number: number, change: { title?: string; body?: string }): Promise<void> {
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/pulls/${number}`, change);
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#github.write(repo, 'POST', `/repos/${repo}/issues/${number}/labels`, { labels });
  }

  async readyForReview(repo: string, pullRequest: PullRequestRef): Promise<void> {
    await this.#github.graphql(repo, READY, { id: pullRequest.nodeId }, z.unknown());
  }

  async updateBranch(repo: string, number: number, expectedHead: string): Promise<void> {
    await this.#github.write(repo, 'PUT', `/repos/${repo}/pulls/${number}/update-branch`, {
      expected_head_sha: expectedHead,
    });
  }

  async review(
    repo: string,
    number: number,
    { commit, body, comments }: { commit: string; body: string; comments: ReviewComment[] },
  ): Promise<number> {
    const made = await this.#github.write(
      repo,
      'POST',
      `/repos/${repo}/pulls/${number}/reviews`,
      {
        commit_id: commit,
        body,
        event: 'COMMENT',
        comments: comments.map((c) => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
      },
      ID,
    );
    return made.id;
  }

  async createCheckRun(repo: string, report: CheckRunReport): Promise<number> {
    const made = await this.#github.write(repo, 'POST', `/repos/${repo}/check-runs`, checkRunBody(report), ID);
    return made.id;
  }

  async updateCheckRun(repo: string, id: number, report: Partial<CheckRunReport>): Promise<void> {
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/check-runs/${id}`, checkRunBody(report));
  }

  async openIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<number> {
    const made = await this.#github.write(repo, 'POST', `/repos/${repo}/issues`, issue, z.object({ number: NUMBER }));
    return made.number;
  }

  async closeIssue(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    await this.#github.write(repo, 'PATCH', `/repos/${repo}/issues/${number}`, {
      state: 'closed',
      state_reason: reason,
    });
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.#github.write(repo, 'POST', `/repos/${repo}/issues/${number}/comments`, { body });
  }
}

/** What a dry run records for one action: enough to see exactly what would have changed. */
export interface DryRunRecord {
  action: keyof Omit<Actions, 'dryRun'>;
  repo: string;
  at: string;
  /** The action's arguments, with file contents as text where they are UTF-8, and base64 where they are not. */
  args: unknown;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/** File contents as they will read in the record. */
function shown(contents: Uint8Array): { text: string } | { base64: string } {
  try {
    return { text: decoder.decode(contents) };
  } catch {
    return { base64: Buffer.from(contents).toString('base64') };
  }
}

export class DryRunActions implements Actions {
  readonly dryRun = true;
  readonly #artifacts: ArtifactStore;
  readonly #log: Logger;
  readonly #now: () => Date;
  /**
   * Numbers for what would have been made, from a billion up: positive, as every action that takes one requires,
   * and far beyond any this repository will reach, so none can be taken for a real one.
   */
  #next = 1_000_000_000;

  constructor(artifacts: ArtifactStore, log: Logger, now: () => Date = () => new Date()) {
    this.#artifacts = artifacts;
    this.#log = log;
    this.#now = now;
  }

  async #record(action: DryRunRecord['action'], repo: string, args: unknown): Promise<string> {
    const record: DryRunRecord = { action, repo, at: this.#now().toISOString(), args };
    const hash = await this.#artifacts.put(new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`));
    this.#log.info({ action, repo, artifact: hash }, `dry run: would ${action}`);
    return hash;
  }

  #number(): number {
    this.#next += 1;
    return this.#next;
  }

  async setBranch(repo: string, branch: string, sha: string, options: { force?: boolean } = {}): Promise<void> {
    await this.#record('setBranch', repo, { branch, sha, ...options });
  }

  async deleteBranch(repo: string, branch: string): Promise<void> {
    await this.#record('deleteBranch', repo, { branch });
  }

  async commit(repo: string, commit: Commit): Promise<string> {
    const { changes, ...rest } = commit;
    const hash = await this.#record('commit', repo, {
      ...rest,
      changes: {
        additions: changes.additions.map((a) => ({ path: a.path, ...shown(a.contents) })),
        deletions: changes.deletions,
      },
    });
    // The record's own hash stands in for the commit's: it is as long, and names something that can be looked up.
    return hash.slice(0, 40);
  }

  async openPullRequest(repo: string, draft: PullRequestDraft): Promise<PullRequestRef> {
    await this.#record('openPullRequest', repo, draft);
    const number = this.#number();
    return { number, url: `dry-run:${repo}#${number}`, nodeId: `dry-run-${number}` };
  }

  async updatePullRequest(repo: string, number: number, change: { title?: string; body?: string }): Promise<void> {
    await this.#record('updatePullRequest', repo, { number, ...change });
  }

  async addLabels(repo: string, number: number, labels: string[]): Promise<void> {
    await this.#record('addLabels', repo, { number, labels });
  }

  async readyForReview(repo: string, pullRequest: PullRequestRef): Promise<void> {
    await this.#record('readyForReview', repo, { number: pullRequest.number });
  }

  async updateBranch(repo: string, number: number, expectedHead: string): Promise<void> {
    await this.#record('updateBranch', repo, { number, expectedHead });
  }

  async review(
    repo: string,
    number: number,
    review: { commit: string; body: string; comments: ReviewComment[] },
  ): Promise<number> {
    await this.#record('review', repo, { number, ...review });
    return this.#number();
  }

  async createCheckRun(repo: string, report: CheckRunReport): Promise<number> {
    await this.#record('createCheckRun', repo, report);
    return this.#number();
  }

  async updateCheckRun(repo: string, id: number, report: Partial<CheckRunReport>): Promise<void> {
    await this.#record('updateCheckRun', repo, { id, ...report });
  }

  async openIssue(repo: string, issue: { title: string; body: string; labels?: string[] }): Promise<number> {
    await this.#record('openIssue', repo, issue);
    return this.#number();
  }

  async closeIssue(repo: string, number: number, reason: 'completed' | 'not_planned'): Promise<void> {
    await this.#record('closeIssue', repo, { number, reason });
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    await this.#record('comment', repo, { number, body });
  }
}
