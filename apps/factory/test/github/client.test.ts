import { createPrivateKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt, InstallationTokens } from '../../src/github/app.ts';
import { GitHubError } from '../../src/github/client.ts';
import { CLIENT_ID, calls, client, PRIVATE_KEY, REPO, type Sent, verifyJwt } from './fake.ts';

describe('the App', () => {
  it('signs a JWT GitHub accepts: issued by the Client ID a minute ago, for nine minutes', () => {
    const now = Date.parse('2026-10-04T12:00:00Z');
    const claims = verifyJwt(appJwt(CLIENT_ID, createPrivateKey(PRIVATE_KEY), now));
    expect(claims).toEqual({ iss: CLIENT_ID, iat: now / 1000 - 60, exp: now / 1000 + 540 });
  });

  it('makes one token per repository, narrowed to it, and reuses it until shortly before it expires', async () => {
    let now = Date.parse('2026-10-04T12:00:00Z');
    const made: unknown[] = [];
    const tokens = new InstallationTokens(
      { clientId: CLIENT_ID, privateKey: PRIVATE_KEY },
      async (method, path, _jwt, body) => {
        if (method === 'GET') return { id: 42 };
        made.push({ path, body });
        return { token: `t${made.length}`, expires_at: new Date(now + 3600_000).toISOString() };
      },
      () => now,
    );
    const [a, b] = await Promise.all([tokens.token(REPO), tokens.token(REPO)]);
    expect([a, b]).toEqual(['t1', 't1']);
    expect(made).toEqual([
      { path: '/app/installations/42/access_tokens', body: { repositories: ['cv-worlds-worst-website'] } },
    ]);
    now += 54 * 60_000;
    expect(await tokens.token(REPO)).toBe('t1');
    now += 2 * 60_000; // four minutes left: inside the margin
    expect(await tokens.token(REPO)).toBe('t2');
  });

  it('refuses a key that is not a key when it starts, not at its first write', () => {
    expect(() => new InstallationTokens({ clientId: CLIENT_ID, privateKey: 'not a key' }, async () => ({}))).toThrow();
  });
});

describe('the client', () => {
  it('calls as the installation, with a token for that repository', async () => {
    const { github, sent } = client([{ method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { id: 1 } }) }]);
    expect(await github.request(REPO, 'GET', `/repos/${REPO}`)).toEqual({ id: 1 });
    const [call] = calls(sent);
    expect(call?.headers.authorization).toMatch(/^token ghs_test\d+$/);
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('with no key, reads unauthenticated and refuses to write before sending anything', async () => {
    const { github, sent } = client(
      [{ method: 'GET', path: `/repos/${REPO}`, answer: () => ({ body: { id: 1 } }) }],
      [],
      { keyless: true },
    );
    expect(github.writable).toBe(false);
    await github.request(REPO, 'GET', `/repos/${REPO}`);
    expect(sent[0]?.headers.authorization).toBeUndefined();
    await expect(github.request(REPO, 'POST', `/repos/${REPO}/issues`, {})).rejects.toMatchObject({
      kind: 'read-only',
    });
    await expect(github.graphql(REPO, 'query { viewer { login } }', {})).rejects.toMatchObject({ kind: 'read-only' });
    expect(sent).toHaveLength(1);
  });

  it('polls with the last ETag, and an answer GitHub says has not changed comes from the cache', async () => {
    let state = 1;
    const { github, sent } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls`,
        answer: ({ headers }) =>
          headers['if-none-match'] === `"v${state}"`
            ? { status: 304, headers: { etag: `"v${state}"` } }
            : { body: [{ number: state }], headers: { etag: `"v${state}"` } },
      },
    ]);
    expect(await github.poll(REPO, `/repos/${REPO}/pulls`)).toEqual({ changed: true, body: [{ number: 1 }] });
    expect(await github.poll(REPO, `/repos/${REPO}/pulls`)).toEqual({ changed: false, body: [{ number: 1 }] });
    state = 2;
    expect(await github.poll(REPO, `/repos/${REPO}/pulls`)).toEqual({ changed: true, body: [{ number: 2 }] });
    expect(calls(sent).map((s) => s.headers['if-none-match'])).toEqual([undefined, '"v1"', '"v1"']);
  });

  it('waits out a rate limit GitHub names, then tries again', async () => {
    const waits: number[] = [];
    const { github } = client(
      [
        {
          method: 'GET',
          path: `/repos/${REPO}`,
          answer: () =>
            waits.length
              ? { body: { ok: true } }
              : { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '7' } },
        },
      ],
      [],
      { sleep: async (ms) => void waits.push(ms) },
    );
    expect(await github.request(REPO, 'GET', `/repos/${REPO}`)).toEqual({ ok: true });
    expect(waits).toEqual([7000]);
  });

  it('makes the token again, once, when GitHub no longer accepts it', async () => {
    const seen: string[] = [];
    const { github } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}`,
        answer: ({ headers }) => {
          seen.push(headers.authorization ?? '');
          return seen.length === 1 ? { status: 401, body: { message: 'Bad credentials' } } : { body: { ok: true } };
        },
      },
    ]);
    expect(await github.request(REPO, 'GET', `/repos/${REPO}`)).toEqual({ ok: true });
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("gives GitHub's reason and a kind to act on, and never a token", async () => {
    const sent: Sent[] = [];
    const { github } = client(
      [
        {
          method: 'POST',
          path: `/repos/${REPO}/pulls`,
          answer: () => ({
            status: 422,
            body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] },
          }),
        },
        {
          method: 'GET',
          path: `/repos/${REPO}/nothing`,
          answer: () => ({ status: 404, body: { message: 'Not Found' } }),
        },
        { method: 'GET', path: `/repos/${REPO}/broken`, answer: () => ({ status: 502 }) },
      ],
      sent,
    );
    const conflict = (await github.request(REPO, 'POST', `/repos/${REPO}/pulls`, {}).catch((e) => e)) as GitHubError;
    expect(conflict).toBeInstanceOf(GitHubError);
    expect(conflict).toMatchObject({ kind: 'conflict', status: 422 });
    expect(conflict.message).toBe(
      `POST /repos/${REPO}/pulls answered 422: Validation Failed; A pull request already exists`,
    );
    await expect(github.request(REPO, 'GET', `/repos/${REPO}/nothing`)).rejects.toMatchObject({ kind: 'not-found' });
    const server = (await github.request(REPO, 'GET', `/repos/${REPO}/broken`).catch((e) => e)) as GitHubError;
    expect(server).toMatchObject({ kind: 'server', status: 502 });
    expect(calls(sent).filter((s) => s.path.endsWith('/broken'))).toHaveLength(4); // the first try and three more
    const token = calls(sent)[0]?.headers.authorization?.replace('token ', '') ?? '';
    for (const error of [conflict, server])
      expect(JSON.stringify({ ...error, message: error.message })).not.toContain(token);
  });

  it('throws GraphQL errors, which GitHub sends with a 200, with their kind', async () => {
    const { github } = client([
      {
        method: 'POST',
        path: '/graphql',
        answer: () => ({
          body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] },
        }),
      },
    ]);
    await expect(github.graphql(REPO, 'mutation { x }', {})).rejects.toMatchObject({
      kind: 'refused',
      message: 'Resource not accessible by integration',
    });
  });
});
