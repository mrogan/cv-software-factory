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
 *   pull request's head as it is now, judged on every open pull request here whose head that commit is, since a check
 *   on a commit is each one's. It passes only when each passes, and otherwise names those that do not, so every run
 *   that judges a commit, whichever pull request asked, says the same of it from the same reviews;
 * - for the merge queue: the check goes on the merge group's commit, judged on the pull request it was made for, which
 *   the queue names in its branch. A queued stack has an entry for each of its pull requests, each with a branch of
 *   that ordinary name and built on the entry below it, so an upper one's commit carries the changes below it too: one
 *   into another branch is judged with every pull request below it, down to the one into main, and passes only when
 *   each does. A branch the gate does not know, or a stack it cannot follow down to main, fails the check there,
 *   saying why.
 *
 * A pull request it finds open always gets a verdict, passing or failing, so a missing check never hides why a pull
 * request waits. The verdict is in the check's title and the run's log; the gate writes no file.
 *
 * Anyone who can push a branch can make a run of a workflow named "review requested", so a `workflow_run` says only
 * which pull request to look at again. The verdict is always read afresh from GitHub, so a forged request reruns the
 * honest gate.
 *
 *     GH_TOKEN         the workflow's token, to read the pull request and its reviews
 *     CHECKS_TOKEN     the review App's installation token, to post the check. Without it, the verdict is said and not
 *                      posted: the App is not set up yet
 *     GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY, GITHUB_API_URL   as Actions sets them
 */
import { readFileSync } from 'node:fs';

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
  head: { sha: string; ref: string; repo: { full_name: string } | null };
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
 * The open pull requests in `repo` whose head is `commit`, from those GitHub lists for the commit, which include merged
 * ones that contain it, and from `known`, one already found there, in case the list lags behind. For a commit already
 * on the default branch, GitHub lists only the pull request that merged it, so `known` is the only open one found.
 */
export function atHead(
  listed: readonly PullRequest[],
  commit: string,
  repo: string,
  known?: PullRequest,
): PullRequest[] {
  const all = new Map<number, PullRequest>();
  for (const pr of [...listed, ...(known ? [known] : [])]) {
    if (pr.state === 'open' && pr.head.sha === commit && pr.base.repo.full_name === repo) all.set(pr.number, pr);
  }
  return [...all.values()].sort((a, b) => a.number - b.number);
}

/** Pull requests by number, the first few: a check's title is one line, however many share a head. */
const names = (prs: readonly { number: number }[]) =>
  prs.length > 5
    ? `${prs
        .slice(0, 5)
        .map((p) => `#${p.number}`)
        .join(', ')} and ${prs.length - 5} more`
    : prs.map((p) => `#${p.number}`).join(', ');

/**
 * The verdict on a commit that is the head of several open pull requests. A check is on a commit, so it is every one's:
 * it passes only when each passes, and otherwise names those that do not, so every run that judges the commit, from any
 * of them, says the same.
 */
export function together(judged: readonly { number: number; said: Verdict }[]): Verdict {
  if (judged.length === 1 && judged[0]) return judged[0].said;
  const held = judged.filter((j) => !j.said.pass);
  if (held.length === 0) return { pass: true, title: `Each of ${names(judged)} passes` };
  if (held.length === 1 && held[0]) return { pass: false, title: `#${held[0].number}: ${held[0].said.title}` };
  return { pass: false, title: `${names(held)} do not pass: each waits for Martin` };
}

/** The deepest stack the gate follows down from a queued pull request: one deeper fails, as a loop does. */
export const STACK_LIMIT = 10;

/** A queued pull request and those below it, down to the one into main, or why the gate cannot follow them. */
export type Stack = { prs: PullRequest[]; reason?: undefined } | { reason: string; prs?: undefined };

/**
 * The stack a queued pull request heads, from the one into main up to `top`, following each base down to the open pull
 * request here whose head it is. `below(branch)` lists the open pull requests from this repository's branch of that
 * name. It fails unless each step finds exactly one, so a branch two pull requests come from, into different bases,
 * names no stack; and when the pull request below has merged and the one above has not yet been retargeted to main, it
 * finds none, and fails until the queue tries again.
 */
export async function stackOf(
  top: PullRequest,
  repo: string,
  below: (branch: string) => Promise<PullRequest[]>,
): Promise<Stack> {
  const prs = [top];
  for (let at = top; at.base.ref !== 'main'; ) {
    if (prs.length >= STACK_LIMIT)
      return {
        reason: `the stack #${top.number} heads is longer than ${STACK_LIMIT} pull requests, which the gate follows`,
      };
    const base = at.base.ref;
    const found = (await below(base)).filter(
      (pr) =>
        pr.state === 'open' &&
        pr.head.ref === base &&
        pr.head.repo?.full_name === repo &&
        pr.base.repo.full_name === repo,
    );
    const [next, ...more] = found;
    if (!next) return { reason: `#${at.number} is into ${base}, which no open pull request here comes from` };
    if (more.length > 0)
      return { reason: `#${at.number} is into ${base}, which ${names(found)} all come from: no one stack below it` };
    if (prs.some((pr) => pr.number === next.number))
      return { reason: `the stack below #${top.number} comes back to #${next.number}` };
    prs.unshift(next);
    at = next;
  }
  return { prs };
}

/**
 * The pull request a run is about, from the event GitHub handed the workflow, for the repository `repo` (`owner/name`).
 */
export function target(name: string, event: Event, repo: string): Target {
  const run = event.workflow_run;
  if (name !== 'workflow_run' || !run) return { kind: 'none', reason: `nothing to do on ${name}` };
  if (run.event === 'merge_group') {
    const number = QUEUE_BRANCH.exec(run.head_branch ?? '')?.[2];
    // A queued stack's entries have branches of this name too: one the gate cannot read fails the queue's commit, naming
    // the branch.
    if (!number)
      return {
        kind: 'none',
        reason: `the merge queue's branch ${run.head_branch} is not gh-readonly-queue/main/pr-<number>-<commit>, which the gate reads`,
        commit: run.head_sha,
      };
    return { kind: 'queue', number: Number(number), commit: run.head_sha };
  }
  if (run.event === 'pull_request' || run.event === 'pull_request_review') {
    // A pull request whose head is the commit to judge, whichever: every open one with that head is judged with it.
    // GitHub names one only when its branch is in this repository and still at the run's commit; a fork's, or a branch
    // that has moved since, is found by its branch. Only this repository's: a run from a fork's branch can name the
    // fork's own pull requests too.
    const number = run.pull_requests?.find((p) => p.base.repo?.url.endsWith(`/repos/${repo}`))?.number;
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

/** Every item of a list GitHub gives a page at a time. */
async function paged<T>(path: string, token: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await api<T[]>('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

/** The open pull requests in `repo` from `owner`'s branch `branch`, into any base. */
const openFrom = (repo: string, owner: string, branch: string, token: string) =>
  api<PullRequest[]>(
    'GET',
    `/repos/${repo}/pulls?state=open&per_page=100&head=${encodeURIComponent(`${owner}:${branch}`)}`,
    token,
  );

/** Every review of a pull request, oldest first. */
const reviewsOf = (repo: string, number: number, token: string) =>
  paged<Review>(`/repos/${repo}/pulls/${number}/reviews`, token);

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

/** Each pull request judged by the rule, at its own head, each said in the run's log. */
async function judgeEach(repo: string, read: string, prs: readonly PullRequest[]) {
  const judged = [];
  for (const each of prs) {
    const said = verdict(each, await reviewsOf(repo, each.number, read));
    console.log(
      `#${each.number}, into ${each.base.ref}, at ${short(each.head.sha)}: ${said.pass ? `passes: ${said.title}` : said.title}.`,
    );
    judged.push({ number: each.number, said });
  }
  return judged;
}

const RULE = 'Passes when Martin opened the pull request, or approved its head after the last push (ADR 0014).';

/** Every pull request open in `repo` that contains `commit`, merged ones too, as GitHub lists them. */
const containing = (repo: string, commit: string, token: string) =>
  paged<PullRequest>(`/repos/${repo}/commits/${commit}/pulls`, token);

/**
 * Judges the head of `pr` as it is now, on every open pull request whose head it is: a check is on a commit, so each
 * of them carries it, and whichever asked, the verdict is the same.
 */
async function judgeHead(repo: string, read: string, token: string, pr: PullRequest): Promise<void> {
  const commit = pr.head.sha;
  let listed: PullRequest[];
  try {
    listed = await containing(repo, commit, read);
  } catch (error) {
    // Without the list, a verdict could pass a commit another open pull request holds: fail it, saying why.
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    const title = `The gate could not list the pull requests at ${short(commit)}: re-run it`;
    if (pr.state === 'open') await post(repo, token, commit, false, title, `No verdict without the list. ${RULE}`);
    return;
  }
  const open = atHead(listed, commit, repo, pr);
  // A closed pull request merges nothing, and no open one has its head: nothing to hold.
  if (open.length === 0) {
    console.log(`#${pr.number} is ${pr.state}, and no open pull request has ${short(commit)}: nothing to judge.`);
    return;
  }
  const said = together(await judgeEach(repo, read, open));
  const numbers = open.map((each) => `#${each.number}`).join(', ');
  const line = `${short(commit)}, the head of ${numbers}: ${said.pass ? `passes: ${said.title}` : said.title}.`;
  console.log(line);
  await post(repo, token, commit, said.pass, said.title, `${RULE} Judged on ${numbers}, each at ${short(commit)}.`);
}

async function main(): Promise<void> {
  const { GH_TOKEN: read = '', CHECKS_TOKEN: token = '', GITHUB_REPOSITORY: repo = '' } = process.env;
  const name = process.env.GITHUB_EVENT_NAME ?? '';
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH ?? '', 'utf-8')) as Event;
  let asked = target(name, event, repo);
  if (asked.kind === 'find') {
    // The open pull request from that branch, wherever its head is now: the run that asked may be for an older push,
    // and the verdict goes on the head as it is now.
    const { owner, branch } = asked;
    const found = (await openFrom(repo, owner, branch, read))[0];
    asked = found
      ? { kind: 'pull-request', number: found.number }
      : { kind: 'none', reason: `no open pull request has ${owner}:${branch}` };
  }
  if (asked.kind === 'none') {
    console.log(`Nothing to judge: ${asked.reason}.`);
    if (asked.commit) {
      const title = asked.reason.charAt(0).toUpperCase() + asked.reason.slice(1);
      await post(repo, token, asked.commit, false, title, `No pull request to judge. ${RULE}`);
    }
    return;
  }
  const pr = await api<PullRequest>('GET', `/repos/${repo}/pulls/${asked.number}`, read);
  if (asked.kind === 'pull-request') {
    await judgeHead(repo, read, token, pr);
    return;
  }
  // A closed pull request merges nothing: the queue holds none.
  if (pr.state !== 'open') {
    console.log(`#${pr.number} is ${pr.state}: nothing to judge.`);
    return;
  }
  const commit = asked.commit;
  // The queue's commit merges into main, and carries every change below the pull request it was made for: a stacked
  // one's approval vouches for its own change alone, so each pull request below it down to main is judged too.
  // A pull request it finds open always gets a verdict: if GitHub cannot be read, the check fails, saying to re-run it.
  let stack: Stack;
  let judged: { number: number; said: Verdict }[] = [];
  try {
    stack = await stackOf(pr, repo, (branch) => openFrom(repo, repo.split('/')[0] ?? '', branch, read));
    if (stack.prs) judged = await judgeEach(repo, read, stack.prs);
  } catch (error) {
    console.log(`::warning::${error instanceof Error ? error.message : String(error)}`);
    stack = { reason: `the gate could not read the stack #${pr.number} heads, or its reviews: re-run it` };
  }
  if (stack.reason !== undefined) {
    const title = stack.reason.charAt(0).toUpperCase() + stack.reason.slice(1);
    console.log(`Nothing to judge on the merge queue's ${short(commit)}: ${title}.`);
    await post(
      repo,
      token,
      commit,
      false,
      title,
      `The merge queue's commit is judged on a stack down to main. ${RULE}`,
    );
    return;
  }
  const said = together(judged);
  const heads = stack.prs.map((each) => `#${each.number} at ${short(each.head.sha)}`).join(', ');
  console.log(
    `The merge queue's ${short(commit)}, for #${pr.number}: ${said.pass ? `passes: ${said.title}` : said.title}.`,
  );
  await post(repo, token, commit, said.pass, said.title, `${RULE} Judged on ${heads}.`);
}

if (import.meta.main) await main();
