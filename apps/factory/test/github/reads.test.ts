import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { ownsBranch } from '../../src/github/branches.ts';
import { LiveReads } from '../../src/github/reads.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { GitHubWorker, GitHubWorkerError } from '../../src/github/worker-client.ts';
import { calls, client, OTHER_SHA, quiet, REPO, SHA } from './fake.ts';

const PULL = {
  number: 7,
  state: 'closed',
  merged: true,
  merge_commit_sha: OTHER_SHA,
  merged_by: { login: 'mrogan' },
  head: { ref: 'factory/1001-cart', sha: SHA },
  base: { ref: 'main', sha: OTHER_SHA, repo: { full_name: REPO } },
  draft: false,
  node_id: 'PR_7',
  title: 'ignored',
};

const ROUTES = [
  { method: 'GET', path: `/repos/${REPO}/pulls/7`, answer: () => ({ body: PULL }) },
  {
    method: 'GET',
    path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
    answer: () => ({
      body: {
        check_runs: [
          {
            id: 1,
            name: 'test',
            status: 'completed',
            conclusion: 'success',
            app: { slug: 'github-actions' },
            started_at: '2026-10-05T10:00:00Z',
            completed_at: '2026-10-05T10:01:30Z',
            output: { title: 'All 40 tests pass' },
          },
          { id: 2, name: 'journeys', status: 'in_progress', conclusion: null, app: null },
        ],
      },
    }),
  },
  {
    method: 'GET',
    path: `/repos/${REPO}/rules/branches/main`,
    answer: () => ({
      body: [
        { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
        {
          type: 'required_status_checks',
          parameters: { required_status_checks: [{ context: 'test' }, { context: 'journeys' }] },
        },
      ],
    }),
  },
  { method: 'GET', path: `/repos/${REPO}/git/ref/heads/main`, answer: () => ({ body: { object: { sha: SHA } } }) },
  {
    method: 'GET',
    path: `/repos/${REPO}/pulls?head=${encodeURIComponent(`${REPO.split('/')[0]}:factory/1001-cart`)}&state=open&per_page=1`,
    answer: () => ({ body: [{ ...PULL, state: 'open', merged: false, merged_by: null }] }),
  },
  {
    method: 'GET',
    path: `/repos/${REPO}/pulls?head=${encodeURIComponent(`${REPO.split('/')[0]}:factory/1002-none`)}&state=open&per_page=1`,
    answer: () => ({ body: [] }),
  },
];

describe('reading GitHub for the line', () => {
  it('reads a pull request, the check runs on a commit, the checks main requires, a branch’s head and its pull request', async () => {
    const { github } = client(ROUTES);
    const reads = new LiveReads(github);
    expect(await reads.pullRequest(REPO, 7)).toEqual({
      number: 7,
      state: 'closed',
      merged: true,
      mergeCommit: OTHER_SHA,
      mergedBy: 'mrogan',
      head: { ref: 'factory/1001-cart', sha: SHA },
      base: { ref: 'main', sha: OTHER_SHA },
      draft: false,
      nodeId: 'PR_7',
    });
    expect(await reads.checkRuns(REPO, SHA)).toEqual([
      {
        id: 1,
        name: 'test',
        status: 'completed',
        conclusion: 'success',
        app: 'github-actions',
        startedAt: '2026-10-05T10:00:00Z',
        completedAt: '2026-10-05T10:01:30Z',
        title: 'All 40 tests pass',
      },
      {
        id: 2,
        name: 'journeys',
        status: 'in_progress',
        conclusion: null,
        app: null,
        startedAt: null,
        completedAt: null,
        title: null,
      },
    ]);
    expect(await reads.requiredChecks(REPO, 'main')).toEqual(['test', 'journeys']);
    expect(await reads.head(REPO, 'main')).toBe(SHA);
    expect(await reads.pullRequestFrom(REPO, 'factory/1001-cart')).toMatchObject({ number: 7, state: 'open' });
    expect(await reads.pullRequestFrom(REPO, 'factory/1002-none')).toBeNull();
  });
});

describe('the paths no patch may change', () => {
  it('are the workflows, the deployment and what CODEOWNERS gives a person, at the commit asked about', async () => {
    const asked: string[] = [];
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) => {
          asked.push(path);
          return path.startsWith(`/repos/${REPO}/contents/.github/CODEOWNERS?ref=${SHA}`)
            ? {
                body: {
                  type: 'file',
                  encoding: 'base64',
                  content: Buffer.from(
                    '# The rules\n/Dockerfile @mrogan\nAGENTS.md @mrogan\n/deploy/ @mrogan\n',
                  ).toString('base64'),
                },
              }
            : { status: 404, body: { message: 'Not Found' } };
        },
      },
    ]);
    expect(await new LiveReads(github).protectedPaths(REPO, SHA)).toEqual([
      '.github/',
      'deploy/',
      'Dockerfile',
      '**/AGENTS.md',
    ]);
    expect(asked.every((path) => path.endsWith(`?ref=${SHA}`))).toBe(true);
  });

  it('are the rules of the line alone where every CODEOWNERS path is missing or a folder', async () => {
    const { github } = client([
      {
        method: 'GET',
        path: /\/contents\//,
        answer: ({ path }) =>
          path.includes('/contents/CODEOWNERS?')
            ? { body: [{ type: 'file', name: 'README.md' }] }
            : { status: 404, body: { message: 'Not Found' } },
      },
    ]);
    expect(await new LiveReads(github).protectedPaths(REPO, SHA)).toEqual(['.github/', 'deploy/']);
  });
});

describe('the factory’s branches', () => {
  it('are those under factory/ and the deploy branches, and nothing else', () => {
    expect(ownsBranch('factory/1296-prices')).toBe(true);
    expect(ownsBranch('deploy/local')).toBe(true);
    expect(ownsBranch('main')).toBe(false);
    expect(ownsBranch('factory/')).toBe(false);
    expect(ownsBranch('deploy/martins-experiment')).toBe(false);
    expect(ownsBranch('feat/line')).toBe(false);
  });
});

describe('the worker over HTTP, for the line', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function serve(routes = ROUTES) {
    const { github, sent } = client(routes);
    const dryRun = new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet);
    const server = createWorkerServer({
      actions: new LiveActions(github),
      reads: new LiveReads(github),
      dryRun,
      repositories: [REPO],
      health: () => ({}),
      log: quiet,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    close = () => server.close();
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { worker: new GitHubWorker(url), dryRun: new GitHubWorker(url, { dryRun: true }), sent };
  }

  it('answers reads, checked at the door', async () => {
    const { worker } = await serve();
    expect(await worker.read('pullRequest', REPO, { number: 7 })).toMatchObject({ merged: true, mergedBy: 'mrogan' });
    expect(await worker.read('requiredChecks', REPO, { branch: 'main' })).toEqual(['test', 'journeys']);
    await expect(worker.read('checkRuns', REPO, { sha: 'nope' })).rejects.toMatchObject({ status: 400 });
    await expect(worker.read('pullRequest', 'someone/else', { number: 7 })).rejects.toBeInstanceOf(GitHubWorkerError);
  });

  it('refuses to move, delete or commit to a branch the factory does not own, live or in a dry run', async () => {
    const { worker, dryRun, sent } = await serve();
    for (const client of [worker, dryRun]) {
      await expect(client.act('setBranch', REPO, { branch: 'main', sha: SHA, force: true })).rejects.toMatchObject({
        status: 422,
        kind: 'branch-refused',
      });
      await expect(client.act('deleteBranch', REPO, { branch: 'feat/martins-work' })).rejects.toMatchObject({
        status: 422,
      });
      await expect(
        client.act('applyPatch', REPO, { branch: 'main', expectedHead: SHA, patch: 'diff', message: 'm' }),
      ).rejects.toMatchObject({ status: 422, kind: 'branch-refused' });
    }
    // GitHub was never asked.
    expect(calls(sent)).toEqual([]);
  });
});
