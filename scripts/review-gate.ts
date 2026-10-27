/**
 * The review gate (ADR 0014): whether a pull request has Martin's say, posted as the `review` check by the review App.
 * It passes when Martin opened the pull request from a branch here, or when his latest verdict on it approves the commit
 * at its head. Nothing in the rule depends on the base, so a pull request into any branch is judged, a stacked one's
 * into the branch below it too.
 *
 *     node scripts/review-gate.ts      # in review.yml, which GitHub runs from main's copy only
 *
 * It reads the event GitHub hands the workflow, and the pull request and its reviews through the API, and never the
 * pull request's code. It runs on `workflow_run`, after `review-requested.yml` ran, which runs as the pull request or
 * the queue's commit has it and so holds nothing:
 *
 * - for a pull request opened, pushed to, reopened, made ready or edited, and for a review of one: the check goes on the
 *   pull request's head as it is now;
 * - for the merge queue: the check goes on the merge group's commit, judged on the pull request it was made for, which
 *   the queue names in its branch, which must be into main. A branch the gate does not know, or one that names a pull
 *   request into another branch, fails the check there, saying which.
 *
 * A pull request it finds open always gets a verdict, passing or failing, so a missing check never hides why a pull
 * request waits.
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

/**
 * The branch the merge queue makes for a pull request: `gh-readonly-queue/<base>/pr-<number>-<base commit>`, the number
 * its second group. pr-title.yml matches the same in bash, so it is written as a POSIX extended expression too, and a
 * test holds the two the same.
 */
export const QUEUE_BRANCH = /^(refs\/heads\/)?gh-readonly-queue\/main\/pr-([0-9]+)-[0-9a-f]{7,40}$/;

export interface PullRequest {
  number: number;
  state: string;
  user: { id: number } | null;
  head: { sha: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } };
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
  // From a branch in this repository: one Martin opens from someone else's fork would carry their pushes.
  if (pr.user?.id === MARTIN && pr.head.repo?.full_name === pr.base.repo.full_name) {
    return { pass: true, title: 'Martin opened it' };
  }
  const latest = reviews
    .filter((r) => r.user?.id === MARTIN && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state))
    .at(-1);
  const head = short(pr.head.sha);
  if (!latest) return { pass: false, title: `Waits for Martin to approve ${head}` };
  if (latest.state === 'CHANGES_REQUESTED') return { pass: false, title: 'Martin asked for changes' };
  if (latest.state === 'DISMISSED')
    return { pass: false, title: `His last review was dismissed: waits for him to approve ${head}` };
  if (latest.commit_id !== pr.head.sha) {
    const approved = latest.commit_id
      ? `Martin approved ${short(latest.commit_id)}`
      : 'Martin approved an earlier commit';
    return { pass: false, title: `${approved}, and it has moved since: waits for him to approve ${head}` };
  }
  return { pass: true, title: `Martin approved ${head}` };
}

/** What a run is asked to look at: a pull request, and the commit its check goes on (its head, unless the queue's). */
export type Target =
  | { kind: 'pull-request'; number: number; commit?: undefined }
  | { kind: 'queue'; number: number; commit: string }
  | { kind: 'find'; owner: string; branch: string; commit: string }
  /** Nothing to judge. With a commit, the check there fails giving the reason: the queue's, on a branch it cannot read. */
  | { kind: 'none'; reason: string; commit?: string };

interface Event {
  workflow_run?: {
    event: string;
    head_branch: string | null;
    head_sha: string;
    head_repository?: { owner: { login: string } } | null;
    pull_requests?: { number: number; base: { ref: string; repo?: { url: string } } }[];
  };
}

/**
 * Of the open pull requests with one head, the one whose verdict goes on it: the one into main, else the first. GitHub
 * allows one open pull request per head and base, so two share a head only with different bases, and the check on a
 * commit is every such pull request's.
 */
export function pick<T extends { base: { ref: string } }>(prs: readonly T[] | undefined): T | undefined {
  return prs?.find((p) => p.base.ref === 'main') ?? prs?.[0];
}

/**
 * The pull request a run is about, from the event GitHub handed the workflow, for the repository `repo` (`owner/name`).
 */
export function target(name: string, event: Event, repo: string): Target {
  const run = event.workflow_run;
  if (name !== 'workflow_run' || !run) return { kind: 'none', reason: `nothing to do on ${name}` };
  if (run.event === 'merge_group') {
    const number = QUEUE_BRANCH.exec(run.head_branch ?? '')?.[2];
    // A queued stack's branch is not documented: one the gate cannot read fails the queue's commit, naming the branch.
    if (!number)
      return {
        kind: 'none',
        reason: `the merge queue's branch ${run.head_branch} is not gh-readonly-queue/main/pr-<number>-<commit>, which the gate reads`,
        commit: run.head_sha,
      };
    return { kind: 'queue', number: Number(number), commit: run.head_sha };
  }
  if (run.event === 'pull_request' || run.event === 'pull_request_review') {
    // GitHub names the pull request only when its branch is in this repository and still at the run's commit; a fork's,
    // or a branch that has moved since, is found by its branch.
    // Only this repository's: a run from a fork's branch can name the fork's own pull requests too.
    const here = run.pull_requests?.filter((p) => p.base.repo?.url.endsWith(`/repos/${repo}`));
    const number = pick(here)?.number;
    if (number) return { kind: 'pull-request', number };
    const owner = run.head_repository?.owner.login;
    if (!owner || !run.head_branch) return { kind: 'none', reason: `the ${run.event} names no pull request` };
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

/** Posts the `review` check on a commit, as the review App, or says why it cannot. */
async function post(repo: string, token: string, commit: string, pass: boolean, title: string, summary: string) {
  if (!token) {
    console.log(`::notice::The review App is not set up yet (ADR 0014): the ${CHECK} check is not posted.`);
    return;
  }
  await api('POST', `/repos/${repo}/check-runs`, token, {
    name: CHECK,
    head_sha: commit,
    status: 'completed',
    conclusion: pass ? 'success' : 'failure',
    output: { title, summary },
  });
  console.log(`Posted ${CHECK}: ${pass ? 'success' : 'failure'} on ${commit}.`);
}

/** Says a line in the run's log and its summary. */
function say(line: string): void {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

const RULE = 'Passes when Martin opened the pull request, or approved its head after the last push (ADR 0014).';

async function main(): Promise<void> {
  const { GH_TOKEN: read = '', CHECKS_TOKEN: token = '', GITHUB_REPOSITORY: repo = '' } = process.env;
  const name = process.env.GITHUB_EVENT_NAME ?? '';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf-8')) as Event;
  let asked = target(name, event, repo);
  if (asked.kind === 'find') {
    // The open pull request from that branch, wherever its head is now: the run that asked may be for an older push,
    // and the verdict goes on the head as it is now.
    const { owner, branch } = asked;
    const open = await api<PullRequest[]>(
      'GET',
      `/repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      read,
    );
    const found = pick(open);
    asked = found
      ? { kind: 'pull-request', number: found.number }
      : { kind: 'none', reason: `no open pull request has ${owner}:${branch}` };
  }
  if (asked.kind === 'none') {
    say(`Nothing to judge: ${asked.reason}.`);
    if (asked.commit) {
      const title = asked.reason.charAt(0).toUpperCase() + asked.reason.slice(1);
      await post(repo, token, asked.commit, false, title, `No pull request to judge. ${RULE}`);
    }
    return;
  }
  const pr = await api<PullRequest>('GET', `/repos/${repo}/pulls/${asked.number}`, read);
  // A closed pull request merges nothing, and its head may be an open one's too, which a failure here would hold.
  if (pr.state !== 'open') {
    console.log(`#${pr.number} is ${pr.state}: nothing to judge.`);
    return;
  }
  const commit = asked.commit ?? pr.head.sha;
  // The queue's commit merges into main, so it is judged only on a pull request into main: one into another branch,
  // a stacked one's, vouches for its own change and not for those below it, which the commit carries too.
  if (asked.kind === 'queue' && pr.base.ref !== 'main') {
    const title = `The merge queue's branch names #${pr.number}, which is into ${pr.base.ref}, not main`;
    say(`Nothing to judge: ${title}.`);
    await post(
      repo,
      token,
      commit,
      false,
      title,
      `The merge queue's commit is judged on a pull request into main. ${RULE}`,
    );
    return;
  }
  const said = verdict(pr, await reviewsOf(repo, pr.number, read));
  const where = asked.kind === 'queue' ? `the merge queue's ${short(commit)}` : short(commit);
  say(`#${pr.number} into ${pr.base.ref}, on ${where}: ${said.pass ? `passes: ${said.title}` : said.title}.`);
  await post(repo, token, commit, said.pass, said.title, `${RULE} Judged on #${pr.number} at ${short(pr.head.sha)}.`);
}

if (import.meta.main) await main();
