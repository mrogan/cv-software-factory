/**
 * The review gate (ADR 0014): whether a pull request has Martin's say, posted as the `review` check by the review App.
 * It passes when Martin opened the pull request, or when his latest verdict on it approves the commit at its head.
 *
 *     node scripts/review-gate.ts      # in review.yml, which GitHub runs from main's copy only
 *
 * It reads the event GitHub hands the workflow, and the pull request and its reviews through the API, and never the
 * pull request's code. It is run by
 *
 * - `pull_request_target`, when a pull request opens or its head moves: the check goes on its head;
 * - `workflow_run`, after `review-requested.yml` ran for a review of a pull request, which `pull_request_target` does
 *   not see: the check goes on the pull request's head as it is now;
 * - `workflow_run`, after `review-requested.yml` ran for the merge queue: the check goes on the merge group's commit,
 *   judged on the pull request it was made for, which the queue names in its branch.
 *
 * Anyone who can push a branch can make a run of a workflow named "review requested", so a `workflow_run` says only
 * which pull request to look at again. The verdict is always read afresh from GitHub, so a forged request reruns the
 * honest gate.
 *
 *     GH_TOKEN         the workflow's token, to read the pull request and its reviews
 *     CHECKS_TOKEN     the review App's installation token, to post the check. Without it, the verdict is said and not
 *                      posted: the App is not set up yet
 *     GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_STEP_SUMMARY   as Actions sets them
 */
import { appendFileSync, readFileSync } from 'node:fs';

/** Martin's GitHub account, by its id, which never changes: a login can be renamed and taken by someone else. */
export const MARTIN = 6206459;

/** The check the ruleset requires, from the review App's integration only. */
export const CHECK = 'review';

/** The branch the merge queue makes for a pull request: `gh-readonly-queue/<base>/pr-<number>-<base commit>`. */
const QUEUE_BRANCH = /^(?:refs\/heads\/)?gh-readonly-queue\/main\/pr-(\d+)-[0-9a-f]{40}$/;

export interface PullRequest {
  number: number;
  state: string;
  user: { id: number } | null;
  head: { sha: string };
  base: { ref: string };
}

export interface Review {
  user: { id: number } | null;
  state: string;
  commit_id: string | null;
}

export interface Verdict {
  pass: boolean;
  /** One line, the check's title. */
  title: string;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * Whether Martin has had his say on a pull request at its head. A review that only comments says nothing; of the rest,
 * his latest counts: an approval, changes asked, or an approval dismissed. `reviews` is in the order GitHub gives them,
 * oldest first.
 */
export function verdict(pr: PullRequest, reviews: readonly Review[]): Verdict {
  if (pr.user?.id === MARTIN) return { pass: true, title: 'Martin opened it' };
  const latest = reviews
    .filter((r) => r.user?.id === MARTIN && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .at(-1);
  const head = short(pr.head.sha);
  if (!latest) return { pass: false, title: `Waits for Martin to approve ${head}` };
  if (latest.state === 'CHANGES_REQUESTED') return { pass: false, title: 'Martin asked for changes' };
  if (latest.state === 'DISMISSED')
    return { pass: false, title: `His approval was dismissed: waits for him to approve ${head}` };
  if (latest.commit_id !== pr.head.sha) {
    return {
      pass: false,
      title: `Martin approved ${short(latest.commit_id ?? '')}, and it has moved since: waits for him to approve ${head}`,
    };
  }
  return { pass: true, title: `Martin approved ${head}` };
}

/** What a run is asked to look at: a pull request, and the commit its check goes on (its head, unless the queue's). */
export type Target =
  | { kind: 'pull-request'; number: number; commit?: undefined }
  | { kind: 'queue'; number: number; commit: string }
  | { kind: 'find'; owner: string; branch: string; commit: string }
  | { kind: 'none'; reason: string };

interface Event {
  pull_request?: { number: number };
  workflow_run?: {
    event: string;
    head_branch: string | null;
    head_sha: string;
    head_repository?: { owner: { login: string } } | null;
    pull_requests?: { number: number }[];
  };
}

/** The pull request a run is about, from the event GitHub handed the workflow. */
export function target(name: string, event: Event): Target {
  if (name === 'pull_request_target' && event.pull_request) {
    return { kind: 'pull-request', number: event.pull_request.number };
  }
  const run = event.workflow_run;
  if (name !== 'workflow_run' || !run) return { kind: 'none', reason: `nothing to do on ${name}` };
  if (run.event === 'merge_group') {
    const number = QUEUE_BRANCH.exec(run.head_branch ?? '')?.[1];
    if (!number) return { kind: 'none', reason: `${run.head_branch} is not a merge queue branch of main` };
    return { kind: 'queue', number: Number(number), commit: run.head_sha };
  }
  if (run.event === 'pull_request_review') {
    // GitHub names the pull request only when its branch is in this repository; a fork's is found by its branch.
    const number = run.pull_requests?.[0]?.number;
    if (number) return { kind: 'pull-request', number };
    const owner = run.head_repository?.owner.login;
    if (!owner || !run.head_branch) return { kind: 'none', reason: 'the review names no pull request' };
    return { kind: 'find', owner, branch: run.head_branch, commit: run.head_sha };
  }
  return { kind: 'none', reason: `a review is not asked for by ${run.event}` };
}

async function api<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(`${process.env.GITHUB_API_URL ?? 'https://api.github.com'}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

/** Every review of a pull request, oldest first. */
async function reviewsOf(repo: string, number: number, token: string): Promise<Review[]> {
  const all: Review[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<Review[]>('GET', `/repos/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`, token);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

async function main(): Promise<void> {
  const { GH_TOKEN: read = '', CHECKS_TOKEN: post = '', GITHUB_REPOSITORY: repo = '' } = process.env;
  const name = process.env.GITHUB_EVENT_NAME ?? '';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf-8')) as Event;
  let asked = target(name, event);
  if (asked.kind === 'find') {
    const { owner, branch, commit } = asked;
    const open = await api<PullRequest[]>(
      'GET',
      `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      read,
    );
    const found = open.find((p) => p.head.sha === commit);
    asked = found
      ? { kind: 'pull-request', number: found.number }
      : { kind: 'none', reason: `no open pull request has ${owner}:${branch} at ${short(commit)}` };
  }
  if (asked.kind === 'none') {
    console.log(`Nothing to judge: ${asked.reason}.`);
    return;
  }
  const pr = await api<PullRequest>('GET', `/repos/${repo}/pulls/${asked.number}`, read);
  if (pr.state !== 'open' || pr.base.ref !== 'main') {
    console.log(`#${pr.number} is ${pr.state}, into ${pr.base.ref}: nothing to judge.`);
    return;
  }
  const said = verdict(pr, await reviewsOf(repo, pr.number, read));
  const commit = asked.commit ?? pr.head.sha;
  const where = asked.kind === 'queue' ? `the merge queue's ${short(commit)}` : short(commit);
  const line = `#${pr.number} on ${where}: ${said.pass ? `passes: ${said.title}` : said.title}.`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  if (!post) {
    console.log(`::notice::The review App is not set up yet (ADR 0014): the ${CHECK} check is not posted.`);
    return;
  }
  await api('POST', `/repos/${repo}/check-runs`, post, {
    name: CHECK,
    head_sha: commit,
    status: 'completed',
    conclusion: said.pass ? 'success' : 'failure',
    output: {
      title: said.title,
      summary:
        `Passes when Martin opened the pull request, or approved its head after the last push (ADR 0014). ` +
        `Judged on #${pr.number} at ${short(pr.head.sha)}.`,
    },
  });
  console.log(`Posted ${CHECK}: ${said.pass ? 'success' : 'failure'} on ${commit}.`);
}

if (import.meta.main) await main();
