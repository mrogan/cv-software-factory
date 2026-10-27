import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MARTIN,
  type PullRequest,
  pick,
  QUEUE_BRANCH,
  type Review,
  target as targetIn,
  verdict,
} from './review-gate.ts';

const HEAD = 'a'.repeat(40);
const EARLIER = 'b'.repeat(40);
const APP = 1_234_567;
/** This repository, as a run's pull requests name it. */
const HERE = { url: 'https://api.github.com/repos/o/r' };
const target = (name: string, event: Parameters<typeof targetIn>[1]) => targetIn(name, event, 'o/r');

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

  it('judges a pull request into any branch by the same rule: a stacked one’s, a fork’s', () => {
    const stacked = (author: number): PullRequest => ({
      ...pr(author),
      base: { ref: 'fix/below', repo: { full_name: 'o/r' } },
    });
    expect(verdict(stacked(MARTIN), [])).toMatchObject({ pass: true });
    expect(verdict(stacked(APP), [])).toMatchObject({ pass: false });
    expect(verdict(stacked(APP), [review(MARTIN, 'APPROVED', EARLIER)])).toMatchObject({ pass: false });
    expect(verdict(stacked(APP), [review(MARTIN, 'APPROVED')])).toMatchObject({ pass: true });
    const fork = { ...stacked(MARTIN), head: { sha: HEAD, repo: { full_name: 'someone/r' } } };
    expect(verdict(fork, [])).toMatchObject({ pass: false });
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
    const run = { head_sha: HEAD, head_branch: 'fix/x', head_repository: { owner: { login: 'someone' } } };
    for (const event of ['pull_request', 'pull_request_review']) {
      expect(
        target('workflow_run', {
          workflow_run: {
            ...run,
            event,
            pull_requests: [
              { number: 8, base: { ref: 'other', repo: HERE } },
              { number: 7, base: { ref: 'main', repo: HERE } },
            ],
          },
        }),
      ).toEqual({ kind: 'pull-request', number: 7 });
      // A stacked pull request, into the branch below it.
      expect(
        target('workflow_run', {
          workflow_run: { ...run, event, pull_requests: [{ number: 8, base: { ref: 'fix/below', repo: HERE } }] },
        }),
      ).toEqual({ kind: 'pull-request', number: 8 });
      // A fork's own pull request, which a run from its branch can name, is not this repository's.
      const theirs = { number: 3, base: { ref: 'main', repo: { url: 'https://api.github.com/repos/someone/r' } } };
      expect(target('workflow_run', { workflow_run: { ...run, event, pull_requests: [theirs] } }).kind).toBe('find');
      // A fork's: GitHub names no pull request, so it is found by its branch and commit.
      expect(target('workflow_run', { workflow_run: { ...run, event, pull_requests: [] } })).toEqual({
        kind: 'find',
        owner: 'someone',
        branch: 'fix/x',
        commit: HEAD,
      });
      // A deleted fork's names no repository: nothing to find.
      expect(
        target('workflow_run', { workflow_run: { ...run, event, head_repository: null, pull_requests: [] } }).kind,
      ).toBe('none');
    }
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
    expect(target('workflow_run', { workflow_run: { ...run, event: 'push' } })).toEqual({
      kind: 'none',
      reason: 'a review is not asked for by push',
    });
    expect(target('workflow_run', { workflow_run: { ...run, event: 'pull_request_target' } }).kind).toBe('none');
    // A queue branch it cannot read fails the queue's commit, naming the branch, so a queued stack shows its name.
    const other = `gh-readonly-queue/other/pr-7-${EARLIER}`;
    const unread = target('workflow_run', { workflow_run: { ...run, event: 'merge_group', head_branch: other } });
    expect(unread).toMatchObject({ kind: 'none', commit: HEAD });
    expect(unread.kind === 'none' && unread.reason).toContain(other);
    expect(target('push', {}).kind).toBe('none');
    // The gate runs on workflow_run alone: a pull request's own event names nothing.
    expect(target('pull_request_target', {}).kind).toBe('none');
  });
});

describe('the pull request a head’s verdict goes on', () => {
  it('is the one into main, else the first', () => {
    const into = (number: number, ref: string) => ({ number, base: { ref } });
    expect(pick([into(8, 'other'), into(7, 'main')])?.number).toBe(7);
    expect(pick([into(8, 'fix/below'), into(9, 'other')])?.number).toBe(8);
    expect(pick([])).toBeUndefined();
    expect(pick(undefined)).toBeUndefined();
  });
});

describe("the review gate's workflows", () => {
  const gate = readFileSync('.github/workflows/review.yml', 'utf-8');
  const requested = readFileSync('.github/workflows/review-requested.yml', 'utf-8');
  /** A workflow's triggers, the keys under `on:`. */
  const triggers = (workflow: string) =>
    [...(workflow.match(/^on:\n((?: {2}.*\n|\n)*)/m)?.[1] ?? '').matchAll(/^ {2}([\w-]+):/gm)].map((m) => m[1]).sort();

  it('run only main’s copy with the key, and never check out the pull request', () => {
    // workflow_run runs the workflow as main has it; pull_request would run the change's copy. GitHub's default event
    // policy blocks pull_request_target in public repositories.
    expect(triggers(gate)).toEqual(['workflow_call', 'workflow_run']);
    expect(gate).toMatch(/workflow_run:\n {4}workflows: \[review requested\]\n/);
    expect(requested).toMatch(/^name: review requested$/m);
    // The key is in an environment only main may use: a pull request into another branch runs that branch's copy.
    expect(gate).toMatch(/^ {4}environment: review$/m);
    // The review App's Client ID, and its key from that environment or a caller; nothing posts without the key.
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

  it('key a run by the branch that asked, and a deleted fork’s by its own id', () => {
    // By the asking run's repository and branch, whatever the folding of the expression.
    const group = (gate.match(/^ {2}group: >-\n((?: {4}.*\n)+)/m)?.[1] ?? '').replace(/\s+/g, ' ').trim();
    expect(group).toBe(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a GitHub Actions expression, as the workflow holds it
      "review-${{ github.event.workflow_run.head_repository.full_name || format('gone-{0}', github.run_id) }}:${{ github.event.workflow_run.head_branch }}",
    );
  });

  it('read the merge queue’s branch as pr-title.yml does', () => {
    // pr-title.yml matches the branch in bash: the one expression, with the slashes JavaScript escapes left bare.
    const title = readFileSync('.github/workflows/pr-title.yml', 'utf-8');
    expect(title).toContain(`[[ "$QUEUE_BRANCH" =~ ${QUEUE_BRANCH.source.replaceAll('\\/', '/')} ]]`);
    expect(title).toContain('BASH_REMATCH[2]');
  });

  it('ask for it when a pull request into any branch opens or moves, on a review and in the merge queue, holding nothing and running nothing', () => {
    expect(triggers(requested)).toEqual(['merge_group', 'pull_request', 'pull_request_review']);
    // No base filter: a stacked pull request, into the branch below it, needs the check too; `edited` covers its
    // retargeting when the one below merges.
    expect(requested).toMatch(
      /pull_request:\n {4}types: \[opened, reopened, synchronize, ready_for_review, edited\]\n/,
    );
    expect(requested).toMatch(/^permissions: \{\}$/m);
    expect(requested).not.toMatch(/uses:|secrets\./);
  });
});
