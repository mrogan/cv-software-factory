import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { GitHub } from '../../src/github/client.ts';
import { carriesIn, carriesSection, DEPLOYS, DeployRefused, deployTitle } from '../../src/github/deploys.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import {
  CLIENT_ID,
  calls,
  client,
  fakeGitHub,
  OTHER_SHA,
  PRIVATE_KEY,
  quiet,
  REPO,
  type Route,
  type Sent,
  SHA,
} from './fake.ts';

const APP_DEPLOY = DEPLOYS.find((t) => t.repo === REPO) as (typeof DEPLOYS)[number];
const CARRIES = [{ workItem: '1001', title: 'Redirect loop on /departments', issue: 16, pullRequest: 17 }];

/** The app's deploy pull request, #30, for SHA, as GitHub keeps it: what describing it reads and writes. */
function deployPull(pull: { state?: string; head?: string; fork?: boolean; body?: string | null } = {}) {
  let body = pull.body === undefined ? 'Runs `aaaaaaa` on the local cluster.' : pull.body;
  const routes: Route[] = [
    {
      method: 'GET',
      path: `/repos/${REPO}/pulls/30`,
      answer: () => ({
        body: {
          state: pull.state ?? 'open',
          title: deployTitle(APP_DEPLOY, SHA),
          body,
          head: { ref: pull.head ?? APP_DEPLOY.branch, repo: { full_name: pull.fork ? 'someone/fork' : REPO } },
          base: { ref: 'main' },
        },
      }),
    },
    {
      method: 'PATCH',
      path: `/repos/${REPO}/pulls/30`,
      answer: ({ body: change }) => {
        body = (change as { body: string }).body;
        return { body: {} };
      },
    },
  ];
  return { routes, body: () => body };
}

describe('acting in GitHub', () => {
  it('commits through GraphQL, so GitHub signs it, with the files as base64 and the message split', async () => {
    const { github, sent } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({ body: { data: { createCommitOnBranch: { commit: { oid: OTHER_SHA } } } } }),
      },
    ]);
    const oid = await new LiveActions(github).commit(REPO, {
      branch: 'factory/1001-cart',
      expectedHead: SHA,
      message: 'fix(cart): count the last item\n\nThe loop stopped one short.',
      changes: {
        additions: [{ path: 'src/cart.ts', contents: new TextEncoder().encode('ok\n') }],
        deletions: ['old.ts'],
      },
    });
    expect(oid).toBe(OTHER_SHA);
    const call = calls(sent)[0]?.body as { query: string; variables: unknown };
    expect(call.query).toContain('createCommitOnBranch');
    expect(call.variables).toEqual({
      input: {
        branch: { repositoryNameWithOwner: REPO, branchName: 'factory/1001-cart' },
        expectedHeadOid: SHA,
        message: { headline: 'fix(cart): count the last item', body: 'The loop stopped one short.' },
        fileChanges: { additions: [{ path: 'src/cart.ts', contents: 'b2sK' }], deletions: [{ path: 'old.ts' }] },
      },
    });
  });

  it('moves a branch that exists, and makes one that does not', async () => {
    const existing = new Set(['deploy/local']);
    const { github, sent } = client([
      {
        method: 'GET',
        path: /^\/repos\/.+\/git\/ref\/heads\//,
        answer: ({ path }) =>
          existing.has(path.split('/heads/')[1] ?? '') ? { body: {} } : { status: 404, body: { message: 'Not Found' } },
      },
      { method: 'PATCH', path: /^\/repos\/.+\/git\/refs\/heads\//, answer: () => ({ body: {} }) },
      { method: 'POST', path: `/repos/${REPO}/git/refs`, answer: () => ({ status: 201, body: {} }) },
    ]);
    const actions = new LiveActions(github);
    await actions.setBranch(REPO, 'deploy/local', SHA, { force: true });
    await actions.setBranch(REPO, 'factory/1001-cart', SHA);
    // Whether it exists is asked first, not read off an error's words.
    expect(calls(sent).map((s) => [s.method, s.path, s.body])).toEqual([
      ['GET', `/repos/${REPO}/git/ref/heads/deploy/local`, undefined],
      ['PATCH', `/repos/${REPO}/git/refs/heads/deploy/local`, { sha: SHA, force: true }],
      ['GET', `/repos/${REPO}/git/ref/heads/factory/1001-cart`, undefined],
      ['POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/factory/1001-cart', sha: SHA }],
    ]);
  });

  it('opens a labelled draft, readies it, and reviews with comments that never approve', async () => {
    const { github, sent } = client([
      {
        method: 'POST',
        path: `/repos/${REPO}/pulls`,
        answer: () => ({ status: 201, body: { number: 7, html_url: 'https://github.test/pr/7', node_id: 'PR_7' } }),
      },
      { method: 'POST', path: `/repos/${REPO}/issues/7/labels`, answer: () => ({ body: [] }) },
      { method: 'POST', path: '/graphql', answer: () => ({ body: { data: {} } }) },
      { method: 'POST', path: `/repos/${REPO}/pulls/7/reviews`, answer: () => ({ body: { id: 99 } }) },
    ]);
    const actions = new LiveActions(github);
    const pr = await actions.openPullRequest(REPO, {
      head: 'factory/1001-cart',
      base: 'main',
      title: 'fix(cart): count the last item',
      body: 'Fixes #3',
      draft: true,
      labels: ['factory'],
    });
    expect(pr).toEqual({ number: 7, url: 'https://github.test/pr/7', nodeId: 'PR_7' });
    await actions.readyForReview(REPO, pr);
    const review = await actions.review(REPO, 7, {
      commit: SHA,
      body: 'One finding.',
      comments: [{ path: 'src/cart.ts', line: 12, body: 'Rule 2: …' }],
    });
    expect(review).toBe(99);
    const bodies = calls(sent).map((s) => s.body);
    expect(bodies[0]).toEqual({
      head: 'factory/1001-cart',
      base: 'main',
      title: 'fix(cart): count the last item',
      body: 'Fixes #3',
      draft: true,
    });
    expect(bodies[1]).toEqual({ labels: ['factory'] });
    expect(bodies[2]).toMatchObject({ variables: { id: 'PR_7' } });
    expect(bodies[3]).toEqual({
      commit_id: SHA,
      body: 'One finding.',
      event: 'COMMENT',
      comments: [{ path: 'src/cart.ts', line: 12, side: 'RIGHT', body: 'Rule 2: …' }],
    });
  });

  it('reports a check run with its output, and closes an issue with its reason', async () => {
    const { github, sent } = client([
      { method: 'POST', path: `/repos/${REPO}/check-runs`, answer: () => ({ status: 201, body: { id: 5 } }) },
      { method: 'PATCH', path: `/repos/${REPO}/check-runs/5`, answer: () => ({ body: {} }) },
      { method: 'PATCH', path: `/repos/${REPO}/issues/3`, answer: () => ({ body: {} }) },
    ]);
    const actions = new LiveActions(github);
    const id = await actions.createCheckRun(REPO, {
      name: 'factory review',
      headSha: SHA,
      status: 'in_progress',
      title: 'Reviewing',
      summary: 'Started.',
    });
    await actions.updateCheckRun(REPO, id, {
      status: 'completed',
      conclusion: 'neutral',
      title: 'Two findings',
      summary: '…',
    });
    await actions.closeIssue(REPO, 3, 'completed');
    expect(calls(sent).map((s) => s.body)).toEqual([
      {
        name: 'factory review',
        head_sha: SHA,
        status: 'in_progress',
        output: { title: 'Reviewing', summary: 'Started.' },
      },
      { status: 'completed', conclusion: 'neutral', output: { title: 'Two findings', summary: '…' } },
      { state: 'closed', state_reason: 'completed' },
    ]);
  });

  it('closes an issue with a comment saying why, once, and says nothing on one already closed', async () => {
    let state = 'open';
    let failClose = 1;
    const comments: { body: string }[] = [];
    const { github, sent } = client([
      { method: 'GET', path: `/repos/${REPO}/issues/16`, answer: () => ({ body: { state } }) },
      { method: 'GET', path: /^\/repos\/.+\/issues\/16\/comments/, answer: () => ({ body: comments }) },
      {
        method: 'POST',
        path: `/repos/${REPO}/issues/16/comments`,
        answer: ({ body }) => {
          comments.push(body as { body: string });
          return { status: 201, body: {} };
        },
      },
      {
        method: 'PATCH',
        path: `/repos/${REPO}/issues/16`,
        answer: () => {
          if (failClose-- > 0) return { status: 422, body: { message: 'Validation Failed' } };
          state = 'closed';
          return { body: {} };
        },
      },
    ]);
    const actions = new LiveActions(github);
    // The first close comments, and its closing fails; trying again closes it, saying nothing twice.
    await expect(actions.closeIssue(REPO, 16, 'completed', 'Verified in production.')).rejects.toThrow();
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    expect(comments).toEqual([{ body: 'Verified in production.' }]);
    expect(
      calls(sent)
        .filter((s) => s.method !== 'GET')
        .map((s) => [s.method, s.body]),
    ).toEqual([
      ['POST', { body: 'Verified in production.' }],
      ['PATCH', { state: 'closed', state_reason: 'completed' }],
      ['PATCH', { state: 'closed', state_reason: 'completed' }],
    ]);
  });
});

describe('describing a deploy', () => {
  it('writes what the deploy pull request carries into its body, and leaves a body that says it already', async () => {
    const pull = deployPull();
    const { github, sent } = client(pull.routes);
    const actions = new LiveActions(github);
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES })).toBe(true);
    expect(pull.body()).toBe(`Runs \`aaaaaaa\` on the local cluster.\n\n${carriesSection(CARRIES)}`);
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES })).toBe(false);
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: [] })).toBe(true);
    expect(carriesIn(pull.body())).toBe(carriesSection([]));
    expect(calls(sent).filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  it('refuses a pull request that is not a deploy, and one no longer for the commit, or no longer open', async () => {
    for (const [pull, commit, refusal] of [
      [{ head: 'factory/1001-cart' }, SHA, DeployRefused],
      [{ fork: true }, SHA, DeployRefused],
      [{}, OTHER_SHA, { kind: 'conflict' }],
      [{ state: 'closed' }, SHA, { kind: 'conflict' }],
    ] as const) {
      const { routes } = deployPull(pull);
      const { github, sent } = client(routes);
      const describing = new LiveActions(github).describeDeploy(REPO, 30, { commit, carries: CARRIES });
      if (refusal === DeployRefused) await expect(describing).rejects.toBeInstanceOf(DeployRefused);
      else await expect(describing).rejects.toMatchObject(refusal);
      expect(calls(sent).filter((c) => c.method === 'PATCH')).toEqual([]);
    }
  });

  it('waits for the watch’s write to the same body, so neither writes over the other with a body it read before', async () => {
    const pull = deployPull();
    const sent: Sent[] = [];
    const fake = fakeGitHub(pull.routes, sent);
    // The watch's write is slow to come back.
    let letGo = () => {};
    const slow = new Promise<void>((resolve) => (letGo = resolve));
    let first = true;
    const github = new GitHub({
      credentials: { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
      api: 'https://api.github.test',
      log: quiet,
      sleep: async () => {},
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PATCH' && first) {
          first = false;
          await slow;
        }
        return fake.fetch(input, init);
      }) as typeof fetch,
    });
    const actions = new LiveActions(github);
    const move = actions.updatePullRequest(REPO, 30, { body: 'Runs `bbbbbbb` on the local cluster.' });
    const describing = actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls(sent)).toEqual([]);
    letGo();
    await Promise.all([move, describing]);
    // The description read the body the move wrote, and kept it.
    expect(calls(sent).map((c) => c.method)).toEqual(['PATCH', 'GET', 'PATCH']);
    expect(pull.body()).toBe(`Runs \`bbbbbbb\` on the local cluster.\n\n${carriesSection(CARRIES)}`);
  });
});

describe('a dry run', () => {
  it('writes each action to the artifact store, sends nothing, and makes nothing that could pass for real', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(new DiskArtifacts(dir), quiet, () => new Date('2026-10-04T12:00:00Z'));
    const oid = await actions.commit(REPO, {
      branch: 'factory/1001-cart',
      expectedHead: SHA,
      message: 'fix(cart): count the last item',
      changes: {
        additions: [
          { path: 'src/cart.ts', contents: new TextEncoder().encode('export const n = 1;\n') },
          { path: 'logo.png', contents: new Uint8Array([0x89, 0x50, 0xff, 0xfe]) },
        ],
        deletions: [],
      },
    });
    const pr = await actions.openPullRequest(REPO, { head: 'factory/1001-cart', base: 'main', title: 't', body: 'b' });
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(pr.number).toBeGreaterThan(1_000_000_000);

    const records = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    const commit = records.find((r) => r.action === 'commit');
    expect(commit).toMatchObject({ repo: REPO, at: '2026-10-04T12:00:00.000Z' });
    expect(commit.args.changes.additions).toEqual([
      { path: 'src/cart.ts', text: 'export const n = 1;\n' },
      { path: 'logo.png', base64: 'iVD//g==' },
    ]);
    expect(records.map((r) => r.action).sort()).toEqual(['commit', 'openPullRequest']);
  });

  it('records what it would have said a deploy carries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(new DiskArtifacts(dir), quiet, () => new Date('2026-10-04T12:00:00Z'));
    expect(await actions.describeDeploy(REPO, 30, { commit: SHA, carries: CARRIES })).toBe(true);
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toEqual({
      action: 'describeDeploy',
      repo: REPO,
      at: '2026-10-04T12:00:00.000Z',
      args: { number: 30, commit: SHA, carries: CARRIES },
    });
  });

  it('records the issue it would have closed, with what it would have said on it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(new DiskArtifacts(dir), quiet, () => new Date('2026-10-04T12:00:00Z'));
    await actions.closeIssue(REPO, 16, 'completed', 'Verified in production.');
    const [record] = await Promise.all(
      (await readdir(dir)).map(async (f) => JSON.parse(await readFile(join(dir, f), 'utf-8'))),
    );
    expect(record).toMatchObject({
      action: 'closeIssue',
      args: { number: 16, reason: 'completed', comment: 'Verified in production.' },
    });
  });
});

describe('the worker over HTTP', () => {
  let close: (() => void) | undefined;
  let baseUrl = '';
  afterEach(() => close?.());

  async function serve(actions: ConstructorParameters<typeof LiveActions>[0] | DryRunActions) {
    const server = createWorkerServer({
      actions: actions instanceof DryRunActions ? actions : new LiveActions(actions),
      repositories: [REPO],
      health: () => ({ mode: 'test' }),
      log: quiet,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => server.close();
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    baseUrl = base;
    return (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as { message?: string } & Record<string, unknown>,
      }));
  }

  it('acts for a configured repository, with arguments checked at the door', async () => {
    const { github, sent } = client([
      { method: 'POST', path: `/repos/${REPO}/issues`, answer: () => ({ status: 201, body: { number: 12 } }) },
    ]);
    const call = await serve(github);
    expect(await call('/v1/actions/openIssue', { repo: REPO, title: 'A broken link', body: '…' })).toEqual({
      status: 200,
      body: { result: 12, dryRun: false },
    });
    expect(await call('/v1/actions/openIssue', { repo: 'someone/else', title: 'x', body: '' })).toMatchObject({
      status: 400,
      body: { message: `repo must be one of ${REPO}.` },
    });
    const bad = await call('/v1/actions/commit', {
      repo: REPO,
      branch: 'factory/../main',
      expectedHead: 'nope',
      message: 'x',
      changes: { additions: [{ path: '../../etc/passwd', contents: 'eA==' }], deletions: [] },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/branch.*expectedHead.*changes\.additions\.0\.path/s);
    expect(await call('/v1/actions/mergePullRequest', { repo: REPO })).toMatchObject({ status: 404 });
    expect(calls(sent)).toHaveLength(1);
  });

  it("keeps a GitHub failure's meaning", async () => {
    const { github } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({
          body: {
            errors: [{ type: 'FORBIDDEN', message: 'refusing to allow a GitHub App to create or update workflow' }],
          },
        }),
      },
    ]);
    const call = await serve(github);
    const refused = await call('/v1/actions/commit', {
      repo: REPO,
      branch: 'factory/1001-cart',
      expectedHead: SHA,
      message: 'ci: x',
      changes: { additions: [{ path: '.github/workflows/x.yml', contents: 'eA==' }], deletions: [] },
    });
    expect(refused).toEqual({
      status: 403,
      body: { error: 'refused', message: 'refusing to allow a GitHub App to create or update workflow' },
    });
    const { github: keyless } = client([], [], { keyless: true });
    close?.();
    const readOnly = await (await serve(keyless))('/v1/actions/comment', { repo: REPO, number: 1, body: 'hi' });
    expect(readOnly).toMatchObject({ status: 503, body: { error: 'read-only' } });
  });

  it('describes a deploy with its list checked at the door, and refuses a pull request that is not one', async () => {
    const pull = deployPull({ head: 'factory/1001-cart' });
    const { github, sent } = client(pull.routes);
    const call = await serve(github);
    const ask = (carries: unknown) =>
      call('/v1/actions/describeDeploy', { repo: REPO, number: 30, commit: SHA, carries });
    expect(await ask(CARRIES)).toMatchObject({ status: 422, body: { error: 'deploy-refused' } });
    for (const carries of [
      [{ ...CARRIES[0], workItem: '../1' }],
      [{ ...CARRIES[0], title: 'x'.repeat(121) }],
      [{ ...CARRIES[0], markdown: '**' }],
      Array.from({ length: 51 }, () => CARRIES[0]),
    ]) {
      expect(await ask(carries)).toMatchObject({ status: 400 });
    }
    expect(calls(sent)).toHaveLength(1);
  });

  it('refuses a body that does not say it is JSON, which is all a web page can send unasked', async () => {
    const { github, sent } = client([]);
    await serve(github);
    const plain = await fetch(`${baseUrl}/v1/actions/comment`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ repo: REPO, number: 1, body: 'hi' }),
    });
    expect(plain.status).toBe(415);
    expect(calls(sent)).toEqual([]);
  });

  it('chains a dry run’s actions: what it would have opened can be labelled, readied and commented on', async () => {
    const call = await serve(new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet));
    const opened = await call('/v1/actions/openPullRequest', {
      repo: REPO,
      head: 'factory/1-cart',
      base: 'main',
      title: 't',
      body: 'b',
    });
    const pullRequest = opened.body.result as { number: number; url: string; nodeId: string };
    expect(
      (await call('/v1/actions/addLabels', { repo: REPO, number: pullRequest.number, labels: ['factory'] })).status,
    ).toBe(200);
    expect((await call('/v1/actions/readyForReview', { repo: REPO, pullRequest })).status).toBe(200);
    expect((await call('/v1/actions/comment', { repo: REPO, number: pullRequest.number, body: 'Ready.' })).status).toBe(
      200,
    );
  });

  it('says it is a dry run in every answer', async () => {
    const call = await serve(new DryRunActions(new DiskArtifacts(await mkdtemp(join(tmpdir(), 'dry-run-'))), quiet));
    expect(await call('/v1/actions/deleteBranch', { repo: REPO, branch: 'factory/1001-cart' })).toEqual({
      status: 200,
      body: { result: null, dryRun: true },
    });
    expect(await call('/health')).toEqual({ status: 200, body: { status: 'ok', mode: 'test' } });
  });
});
