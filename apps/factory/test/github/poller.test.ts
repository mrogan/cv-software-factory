import { describe, expect, it } from 'vitest';
import { checkRunsWatch, imagesWatch, mergesWatch, Poller } from '../../src/github/poller.ts';
import { Registry } from '../../src/github/registry.ts';
import { client, quiet, REPO, SHA } from './fake.ts';

const run = (id: number, status: string, conclusion: string | null) => ({
  id,
  name: `check ${id}`,
  status,
  conclusion,
  app: { slug: 'github-actions' },
  details_url: null,
});

describe('watching check runs', () => {
  it('hands over each run whose state changed, asking GitHub conditionally', async () => {
    let runs = [run(1, 'in_progress', null), run(2, 'queued', null)];
    let etag = 1;
    const { github, sent } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
        answer: ({ headers }) =>
          headers['if-none-match'] === `"${etag}"`
            ? { status: 304 }
            : { body: { check_runs: runs }, headers: { etag: `"${etag}"` } },
      },
    ]);
    const handed: string[][] = [];
    const watch = checkRunsWatch(github, REPO, SHA, (changed) => {
      handed.push(changed.map((r) => `${r.id}:${r.status}/${r.conclusion}`));
    });
    await watch();
    await watch(); // 304: nothing new
    runs = [run(1, 'completed', 'success'), run(2, 'queued', null)];
    etag = 2;
    await watch();
    expect(handed).toEqual([['1:in_progress/null', '2:queued/null'], ['1:completed/success']]);
    expect(sent.filter((s) => s.path.includes('check-runs')).map((s) => s.headers['if-none-match'])).toEqual([
      undefined,
      '"1"',
      '"1"',
    ]);
  });

  it('hands a change over again when the handler failed, even if GitHub says nothing changed', async () => {
    const { github } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/commits/${SHA}/check-runs?per_page=100`,
        answer: ({ headers }) =>
          headers['if-none-match']
            ? { status: 304 }
            : { body: { check_runs: [run(1, 'completed', 'failure')] }, headers: { etag: '"x"' } },
      },
    ]);
    let attempts = 0;
    const watch = checkRunsWatch(github, REPO, SHA, () => {
      attempts += 1;
      if (attempts === 1) throw new Error('the store was down');
    });
    await expect(watch()).rejects.toThrow('the store was down');
    await watch();
    await watch();
    expect(attempts).toBe(2);
  });
});

describe('watching merges', () => {
  it('hands over each merge since the watch began, oldest first, once', async () => {
    const pulls = [
      {
        number: 9,
        title: 'b',
        user: { login: 'mrogan' },
        head: { ref: 'b' },
        merged_at: '2026-10-04T12:05:00Z',
        merge_commit_sha: 'c9',
      },
      {
        number: 8,
        title: 'a',
        user: { login: 'mrogan-software-factory[bot]' },
        head: { ref: 'a' },
        merged_at: '2026-10-04T12:01:00Z',
        merge_commit_sha: 'c8',
      },
      {
        number: 7,
        title: 'closed',
        user: { login: 'mrogan' },
        head: { ref: 'c' },
        merged_at: null,
        merge_commit_sha: null,
      },
      {
        number: 6,
        title: 'old',
        user: { login: 'mrogan' },
        head: { ref: 'd' },
        merged_at: '2026-10-04T11:00:00Z',
        merge_commit_sha: 'c6',
      },
    ];
    const { github } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
        answer: () => ({ body: pulls }),
      },
    ]);
    const merged: number[] = [];
    const watch = mergesWatch(github, REPO, new Date('2026-10-04T12:00:00Z'), (p) => void merged.push(p.number));
    await watch();
    await watch();
    expect(merged).toEqual([8, 9]);
  });
});

describe('watching images', () => {
  it('hands over the tags when a new one appears', async () => {
    let tags = ['a1'];
    const registry = { tags: async () => tags } as unknown as Registry;
    const seen: string[][] = [];
    const watch = imagesWatch(registry, 'mrogan/x', (t) => void seen.push(t));
    await watch();
    await watch();
    tags = ['a1', 'b2'];
    await watch();
    expect(seen).toEqual([['a1'], ['a1', 'b2']]);
  });
});

describe('the poller', () => {
  it('runs every watch, and one failing does not stop the others', async () => {
    const ran: string[] = [];
    const poller = new Poller({ intervalMs: 60_000, log: quiet });
    poller.watch('fails', async () => {
      ran.push('fails');
      throw new Error('GitHub is down');
    });
    poller.watch('works', async () => void ran.push('works'));
    await poller.tick();
    poller.unwatch('fails');
    await poller.tick();
    expect(ran).toEqual(['fails', 'works', 'works']);
    expect(poller.watching).toEqual(['works']);
  });

  it('stops between ticks without waiting out the interval', async () => {
    let ticks = 0;
    const poller = new Poller({ intervalMs: 3_600_000, log: quiet });
    poller.watch('count', async () => {
      ticks += 1;
    });
    poller.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await poller.stop();
    expect(ticks).toBe(1);
  });
});

describe('GHCR', () => {
  const image = 'mrogan/cv-worlds-worst-website';
  function registry(requests: string[] = []) {
    const answer = (body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } });
    return new Registry({
      base: 'https://ghcr.test',
      fetch: (async (input: string) => {
        const path = new URL(input).pathname + new URL(input).search;
        requests.push(path);
        if (path.startsWith('/token')) return answer({ token: 'anon' });
        if (path === `/v2/${image}/tags/list?n=1000`)
          return answer({ tags: ['a'] }, { link: `</v2/${image}/tags/list?last=a&n=1000>; rel="next"` });
        if (path === `/v2/${image}/tags/list?last=a&n=1000`) return answer({ tags: ['b'] });
        if (path === `/v2/${image}/manifests/b`)
          return new Response(null, { headers: { 'docker-content-digest': `sha256:${'1'.repeat(64)}` } });
        if (path === `/v2/${image}/manifests/sha256:index`)
          return answer({
            manifests: [
              { digest: 'sha256:amd', platform: { os: 'linux' } },
              { digest: 'sha256:arm', platform: { os: 'linux' } },
              { digest: 'sha256:att', platform: { os: 'unknown' } },
            ],
          });
        if (path === `/v2/${image}/manifests/sha256:amd`) return answer({ config: { digest: 'sha256:c1' } });
        if (path === `/v2/${image}/manifests/sha256:arm`) return answer({ config: { digest: 'sha256:c2' } });
        if (path.startsWith(`/v2/${image}/blobs/`))
          return answer({ config: { Labels: { 'org.opencontainers.image.revision': SHA } } });
        return new Response(null, { status: 404 });
      }) as typeof fetch,
    });
  }

  it('lists every page of tags, finds a digest, and reads the commit each platform was built from', async () => {
    const requests: string[] = [];
    const r = registry(requests);
    expect(await r.tags(image)).toEqual(['a', 'b']);
    expect(await r.digest(image, 'b')).toBe(`sha256:${'1'.repeat(64)}`);
    expect(await r.revision(image, 'sha256:index')).toBe(SHA);
    expect(requests.filter((p) => p.startsWith('/token'))).toHaveLength(1);
    expect(requests).not.toContain(`/v2/${image}/manifests/sha256:att`);
  });
});
