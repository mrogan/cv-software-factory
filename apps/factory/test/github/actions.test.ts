import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskArtifacts } from '@software-factory/store';
import { afterEach, describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { createWorkerServer } from '../../src/github/server.ts';
import { calls, client, OTHER_SHA, quiet, REPO, SHA } from './fake.ts';

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
      branch: 'fix/1001',
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
        branch: { repositoryNameWithOwner: REPO, branchName: 'fix/1001' },
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
    await actions.setBranch(REPO, 'fix/1001', SHA);
    // Whether it exists is asked first, not read off an error's words.
    expect(calls(sent).map((s) => [s.method, s.path, s.body])).toEqual([
      ['GET', `/repos/${REPO}/git/ref/heads/deploy/local`, undefined],
      ['PATCH', `/repos/${REPO}/git/refs/heads/deploy/local`, { sha: SHA, force: true }],
      ['GET', `/repos/${REPO}/git/ref/heads/fix/1001`, undefined],
      ['POST', `/repos/${REPO}/git/refs`, { ref: 'refs/heads/fix/1001', sha: SHA }],
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
      head: 'fix/1001',
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
      head: 'fix/1001',
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
});

describe('a dry run', () => {
  it('writes each action to the artifact store, sends nothing, and makes nothing that could pass for real', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dry-run-'));
    const actions = new DryRunActions(new DiskArtifacts(dir), quiet, () => new Date('2026-10-04T12:00:00Z'));
    const oid = await actions.commit(REPO, {
      branch: 'fix/1001',
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
    const pr = await actions.openPullRequest(REPO, { head: 'fix/1001', base: 'main', title: 't', body: 'b' });
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
      branch: 'fix/../main',
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
      branch: 'fix/1001',
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
      head: 'fix/1',
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
    expect(await call('/v1/actions/deleteBranch', { repo: REPO, branch: 'fix/1001' })).toEqual({
      status: 200,
      body: { result: null, dryRun: true },
    });
    expect(await call('/health')).toEqual({ status: 200, body: { status: 'ok', mode: 'test' } });
  });
});
