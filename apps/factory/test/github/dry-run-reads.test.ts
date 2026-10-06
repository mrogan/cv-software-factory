import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunActions } from '../../src/github/actions.ts';
import { APP_LOGIN } from '../../src/github/current.ts';
import { DRY_RUN_CHECK_TITLE, DryRunReads } from '../../src/github/dry-run-reads.ts';
import type { Reads } from '../../src/github/reads.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker } from '../../src/github/worker-client.ts';
import { gateEvents, gateRecord } from '../../src/line/gates.ts';
import { quiet, REPO, SHA } from './fake.ts';

const BRANCH = 'factory/1001-cart';
const MINUTE = 60_000;
const TIMES = { checksAfterMs: 2 * MINUTE, mergeAfterMs: 20 * MINUTE };
const REQUIRED = ['Unit tests', 'Journeys'];

/** GitHub as it really is: the app's main, its ruleset, and one real pull request. */
function live(asked: string[] = []): Reads {
  const no = (what: string) => () => Promise.reject(new Error(`GitHub has no ${what}`));
  return {
    pullRequest: async (_repo, number) => {
      asked.push(`pullRequest ${number}`);
      if (number !== 7) return no(`pull request #${number}`)();
      return {
        number: 7,
        state: 'open',
        merged: false,
        mergeCommit: null,
        mergedBy: null,
        head: { ref: 'feat/x', sha: 'c'.repeat(40) },
        base: { ref: 'main', sha: SHA },
        draft: false,
        nodeId: 'PR_real',
      };
    },
    pullRequestFrom: async () => null,
    checkRuns: async (_repo, sha) => {
      asked.push(`checkRuns ${sha}`);
      return [];
    },
    requiredChecks: async () => REQUIRED,
    head: async (_repo, branch) => (branch === 'main' ? SHA : no(`branch ${branch}`)()),
    protectedPaths: async (_repo, ref) => {
      asked.push(`protectedPaths ${ref}`);
      return ['.github/', 'deploy/'];
    },
    comparison: no('comparison'),
  };
}

/** A dry run with a clock, and the app's one file as it is on main. */
async function dryRun(asked: string[] = []) {
  let now = new Date('2026-10-06T22:00:00Z');
  const files: Record<string, string> = { 'src/cart.ts': 'const a = 1;\nconst b = 2;\nconst c = 3;\n' };
  const made = new DryRunActions(
    new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-reads-'))),
    quiet,
    () => now,
    async (_repo, path, ref) => (ref === SHA ? (files[path] ?? null) : null),
  );
  const reads = new DryRunReads(made, live(asked), TIMES, () => now);
  // The coder's push, as the line makes it: the branch at main, its patch, and a draft pull request.
  await made.setBranch(REPO, BRANCH, SHA, { force: true });
  const commit = await made.applyPatch(REPO, {
    branch: BRANCH,
    expectedHead: SHA,
    message: 'fix(cart): count b',
    patch: [
      'diff --git a/src/cart.ts b/src/cart.ts',
      '--- a/src/cart.ts',
      '+++ b/src/cart.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 20;',
      ' const c = 3;',
      '',
    ].join('\n'),
  });
  const { number } = await made.openPullRequest(REPO, {
    head: BRANCH,
    base: 'main',
    title: 't',
    body: 'b',
    draft: true,
  });
  return { made, reads, commit, number, later: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('a dry run’s reads', () => {
  it('answer for the pull request it opened: open, a draft, its head the commit it would have pushed', async () => {
    const { reads, commit, number } = await dryRun();
    expect(await reads.pullRequest(REPO, number)).toMatchObject({
      number,
      state: 'open',
      merged: false,
      head: { ref: BRANCH, sha: commit },
      base: { ref: 'main', sha: SHA },
      draft: true,
    });
    expect(await reads.pullRequestFrom(REPO, BRANCH)).toMatchObject({ number });
    expect(await reads.head(REPO, BRANCH)).toBe(commit);
  });

  it('pass every check main requires, once the checks have had their time, so the gates finish', async () => {
    const { reads, commit, number, later } = await dryRun();
    const read = async () => {
      const pr = await reads.pullRequest(REPO, number);
      return gateEvents(pr, await reads.checkRuns(REPO, pr.head.sha), REQUIRED, gateRecord([]));
    };
    expect((await read()).map((d) => d.type)).toEqual(['gates.started']);

    later(TIMES.checksAfterMs);
    const drafts = await read();
    expect(drafts.map((d) => d.type)).toEqual(['gates.started', 'gate.finished', 'gate.finished', 'gates.finished']);
    expect(drafts.at(-1)?.payload).toMatchObject({ commit, conclusion: 'passed', passed: 2, failed: [] });
    // Nothing ran, and the gate says so.
    expect(drafts[1]?.payload).toMatchObject({ check: 'Unit tests', required: true, summary: DRY_RUN_CHECK_TITLE });
  });

  it('merge it as the App after a while, so the work item ends', async () => {
    const { reads, number, later } = await dryRun();
    later(TIMES.mergeAfterMs);
    const pr = await reads.pullRequest(REPO, number);
    expect(pr).toMatchObject({ state: 'closed', merged: true, mergedBy: APP_LOGIN });
    expect(pr.mergeCommit).toMatch(/^[0-9a-f]{40}$/);
    const [merged] = gateEvents(pr, [], REQUIRED, gateRecord([]));
    expect(merged).toMatchObject({ type: 'pull-request.merged', actor: 'factory', payload: { number, by: 'factory' } });
    expect(await reads.pullRequestFrom(REPO, BRANCH)).toBeNull();
  });

  it('compare its commit with main as GitHub would: from the real commit it went on, with each file’s hunks', async () => {
    const { reads, commit } = await dryRun();
    const compared = await reads.comparison(REPO, 'main', commit);
    expect(compared.mergeBase).toBe(SHA);
    expect(compared.files).toEqual([
      {
        path: 'src/cart.ts',
        added: 1,
        removed: 1,
        patch: '@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;',
      },
    ]);
  });

  it('read the protected paths where its commits went, and everything it did not make from GitHub', async () => {
    const asked: string[] = [];
    const { reads, commit } = await dryRun(asked);
    await reads.protectedPaths(REPO, commit);
    expect(asked).toEqual([`protectedPaths ${SHA}`]);
    expect(await reads.head(REPO, 'main')).toBe(SHA);
    expect((await reads.pullRequest(REPO, 7)).nodeId).toBe('PR_real');
    await reads.checkRuns(REPO, SHA);
    expect(asked).toContain(`checkRuns ${SHA}`);
  });
});

describe('the worker’s reads over HTTP', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('answer from the dry run only for a worker that asks for one', async () => {
    const { made, reads, number } = await dryRun();
    const server = createWorkerServer({
      actions: made,
      reads: live(),
      dryRun: made,
      dryRunReads: reads,
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const pr = await new GitHubWorker(url, { dryRun: true }).read('pullRequest', REPO, { number });
    expect(pr.number).toBe(number);
    await expect(new GitHubWorker(url).read('pullRequest', REPO, { number })).rejects.toThrow();
  });
});
