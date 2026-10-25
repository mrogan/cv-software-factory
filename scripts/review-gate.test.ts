import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARTIN, type PullRequest, QUEUE_BRANCH, type Review, target, verdict } from './review-gate.ts';

const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);
const APP = 1_234_567;

const pr = (author: number | null): PullRequest => ({
  number: 7,
  state: 'open',
  user: author === null ? null : { id: author },
  head: { sha: HEAD, repo: { full_name: 'o/r' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } },
});
const review = (id: number, state: string, commit = HEAD): Review => ({ user: { id }, state, commit_id: commit });

describe('the review gate (ADR 0014)', () => {
  it('passes a pull request Martin opened, by his id', () => {
    expect(verdict(pr(MARTIN), [])).toMatchObject({ pass: true });
    // From someone else's fork, his own pull request waits for his approval like any other.
    const fork = { ...pr(MARTIN), head: { sha: HEAD, repo: { full_name: 'someone/r' } } };
    expect(verdict(fork, [])).toMatchObject({ pass: false });
    expect(verdict({ ...fork, head: { sha: HEAD, repo: null } }, [])).toMatchObject({ pass: false });
    expect(verdict(fork, [review(MARTIN, 'APPROVED')])).toMatchObject({ pass: true });
  });

  it("holds anyone else's until Martin approves its head", () => {
    expect(verdict(pr(APP), [])).toMatchObject({ pass: false });
    expect(verdict(pr(null), [])).toMatchObject({ pass: false });
    expect(verdict(pr(APP), [review(MARTIN, 'APPROVED')])).toMatchObject({ pass: true });
  });

  it('counts only Martin: no other approval, the App’s included', () => {
    expect(verdict(pr(APP), [review(APP, 'APPROVED'), review(42, 'APPROVED')])).toMatchObject({ pass: false });
  });

  it('holds an approval of an earlier commit: a push since needs his approval again', () => {
    const said = verdict(pr(APP), [review(MARTIN, 'APPROVED', EARLIER)]);
    expect(said.pass).toBe(false);
    expect(said.title).toContain('bbbbbbb');
    // An approval of a commit GitHub no longer names still holds, and says so plainly.
    const gone = verdict(pr(APP), [{ user: { id: MARTIN }, state: 'APPROVED', commit_id: null }]);
    expect(gone).toEqual({
      pass: false,
      title: 'Martin approved an earlier commit, and it has moved since: waits for him to approve aaaaaaa',
    });
  });

  it('goes by his latest verdict, and a comment is none', () => {
    expect(verdict(pr(APP), [review(MARTIN, 'APPROVED'), review(MARTIN, 'CHANGES_REQUESTED')])).toMatchObject({
      pass: false,
    });
    expect(verdict(pr(APP), [review(MARTIN, 'CHANGES_REQUESTED'), review(MARTIN, 'APPROVED')])).toMatchObject({
      pass: true,
    });
    expect(verdict(pr(APP), [review(MARTIN, 'APPROVED'), review(MARTIN, 'COMMENTED')])).toMatchObject({ pass: true });
    expect(verdict(pr(APP), [review(MARTIN, 'DISMISSED')])).toMatchObject({ pass: false });
  });

  it('judges the pull request a run names: opened or moved, reviewed, or in the merge queue', () => {
    expect(target('pull_request_target', { pull_request: { number: 7 } })).toEqual({ kind: 'pull-request', number: 7 });
    const run = { head_sha: HEAD, head_branch: 'fix/x', head_repository: { owner: { login: 'someone' } } };
    expect(
      target('workflow_run', {
        workflow_run: {
          ...run,
          event: 'pull_request_review',
          pull_requests: [
            { number: 8, base: { ref: 'other' } },
            { number: 7, base: { ref: 'main' } },
          ],
        },
      }),
    ).toEqual({ kind: 'pull-request', number: 7 });
    // A fork's: GitHub names no pull request, so it is found by its branch and commit.
    expect(
      target('workflow_run', { workflow_run: { ...run, event: 'pull_request_review', pull_requests: [] } }),
    ).toEqual({ kind: 'find', owner: 'someone', branch: 'fix/x', commit: HEAD });
    const queue = `gh-readonly-queue/main/pr-7-${EARLIER}`;
    expect(target('workflow_run', { workflow_run: { ...run, event: 'merge_group', head_branch: queue } })).toEqual({
      kind: 'queue',
      number: 7,
      commit: HEAD,
    });
    // However long the base commit's suffix.
    const short = { ...run, event: 'merge_group', head_branch: 'gh-readonly-queue/main/pr-7-1a2b3c4' };
    expect(target('workflow_run', { workflow_run: short })).toMatchObject({ kind: 'queue', number: 7 });
  });

  it('judges nothing a run cannot name: another event, or a branch that is not the queue’s into main', () => {
    const run = { head_sha: HEAD, head_branch: `gh-readonly-queue/main/pr-7-${EARLIER}` };
    expect(target('workflow_run', { workflow_run: { ...run, event: 'push' } }).kind).toBe('none');
    expect(target('workflow_run', { workflow_run: { ...run, event: 'pull_request' } }).kind).toBe('none');
    expect(
      target('workflow_run', {
        workflow_run: { ...run, event: 'merge_group', head_branch: `gh-readonly-queue/other/pr-7-${EARLIER}` },
      }).kind,
    ).toBe('none');
    expect(target('push', {}).kind).toBe('none');
  });
});

describe("the review gate's workflows", () => {
  const gate = readFileSync('.github/workflows/review.yml', 'utf-8');
  const requested = readFileSync('.github/workflows/review-requested.yml', 'utf-8');
  /** A workflow's triggers, the keys under `on:`. */
  const triggers = (workflow: string) =>
    [...(workflow.match(/^on:\n((?: {2}.*\n|\n)*)/m)?.[1] ?? '').matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]).sort();

  it('run only main’s copy with the key, and never check out the pull request', () => {
    // pull_request_target and workflow_run run the workflow as main has it; pull_request would run the change's copy.
    expect(triggers(gate)).toEqual(['pull_request_target', 'workflow_call', 'workflow_run']);
    expect(gate).toMatch(/pull_request_target:\n {4}branches: \[main\]\n/);
    expect(gate).toMatch(/workflow_run:\n {4}workflows: \[review requested\]\n/);
    expect(requested).toMatch(/^name: review requested$/m);
    // The key is in an environment only main may use: a pull request into another branch runs that branch's copy.
    expect(gate).toMatch(/^ {4}environment: review$/m);
    // The review App's Client ID, and its key from that environment alone; nothing posts without the key.
    expect(gate).toMatch(
      /client-id: Iv23liFNqAvApddT27zU\n {10}private-key: \$\{\{ secrets\.REVIEW_APP_PRIVATE_KEY \}\}\n/,
    );
    expect(gate).toMatch(/- id: app\n {8}if: env\.HAS_KEY == 'true'\n/);
    expect(gate).toMatch(/^permissions: \{\}$/m);
    // Its job reads this repository, to check out the gate, and pull requests; it writes nothing with its own token.
    expect(gate).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}pull-requests: read\n {4}env:/m);
    // The one checkout is this workflow's own commit, main's, and never the pull request's.
    expect(gate.match(/uses: actions\/checkout@/g)).toHaveLength(1);
    expect(gate).toMatch(/ref: \$\{\{ job\.workflow_sha \}\}\n/);
    // Nothing the pull request's author writes reaches a step: its branch names only the concurrency group.
    const steps = gate.slice(gate.indexOf('\njobs:\n'));
    expect(steps).not.toMatch(/github\.event\.(pull_request|workflow_run)\.(head|title|body|user)|github\.head_ref/);
  });

  it('take the key from a caller by name, and need it from none', () => {
    expect(gate).toMatch(
      /workflow_call:\n {4}secrets:\n {6}REVIEW_APP_PRIVATE_KEY:\n {8}description: .+\n {8}required: false\n/,
    );
  });

  it('give a deleted fork’s runs a group of their own, not one they share', () => {
    expect(gate).toContain("format('gone-{0}', github.event.pull_request.number || github.run_id)");
  });

  it('read the merge queue’s branch as pr-title.yml does', () => {
    // pr-title.yml matches the branch in bash: the one expression, with the slashes JavaScript escapes left bare.
    const title = readFileSync('.github/workflows/pr-title.yml', 'utf-8');
    expect(title).toContain(`[[ "$QUEUE_BRANCH" =~ ${QUEUE_BRANCH.source.replaceAll('\\/', '/')} ]]`);
    expect(title).toContain('BASH_REMATCH[2]');
  });

  it('ask for it again on a review and in the merge queue, holding nothing and running nothing', () => {
    expect(triggers(requested)).toEqual(['merge_group', 'pull_request_review']);
    expect(requested).toMatch(/^permissions: \{\}$/m);
    expect(requested).not.toMatch(/uses:|secrets\./);
  });
});
