/**
 * The deploy and release watches, through the watch itself: a fake GitHub and GHCR, and what the watch does to them.
 */
import { describe, expect, it } from 'vitest';
import { type Actions, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { DEPLOYS, type DeployTarget, deployWatch } from '../../src/github/deploys.ts';
import type { Registry } from '../../src/github/registry.ts';
import { releaseWatch } from '../../src/github/releases.ts';
import { calls, client, quiet, type Route, type Sent } from './fake.ts';

const [CONSOLE, FACTORY, APP] = DEPLOYS as [DeployTarget, DeployTarget, DeployTarget];
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const commit = (c: string) => c.repeat(40);
const HEAD = commit('d');

/** A pin file as `kustomize edit` writes one. */
const pinFile = (
  images: [name: string, digest: string, image: string][],
) => `apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
images:
${images.map(([name, d, image]) => `- digest: ${d}\n  name: ${name}\n  newName: ghcr.io/${image}`).join('\n')}
`;
const FACTORY_PIN = pinFile([
  ['factory', digest('1'), 'mrogan/cv-software-factory/factory'],
  ['factory-browser', digest('2'), 'mrogan/cv-software-factory/factory-browser'],
]);

interface Pull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  labels: { name: string }[];
}

/** GitHub with main at d, then c, b, a; a pin file at d; and the deploy branch's pull requests. */
function github(target: DeployTarget, options: { pin?: string; pulls?: Pull[]; failCommit?: boolean } = {}) {
  const { repo } = target;
  const sent: Sent[] = [];
  let failCommit = options.failCommit ?? false;
  const routes: Route[] = [
    { method: 'GET', path: `/repos/${repo}/git/ref/heads/main`, answer: () => ({ body: { object: { sha: HEAD } } }) },
    {
      method: 'GET',
      path: `/repos/${repo}/contents/${target.file}?ref=${HEAD}`,
      answer: () => ({ body: { content: Buffer.from(options.pin ?? FACTORY_PIN).toString('base64') } }),
    },
    {
      method: 'GET',
      path: `/repos/${repo}/commits?sha=${HEAD}&per_page=100`,
      answer: () => ({ body: ['d', 'c', 'b', 'a'].map((c) => ({ sha: commit(c) })) }),
    },
    { method: 'GET', path: /\/pulls\?state=all/, answer: () => ({ body: options.pulls ?? [] }) },
    { method: 'GET', path: /\/git\/ref\/heads\/deploy\//, answer: () => ({ body: {} }) },
    { method: 'PATCH', path: /\/git\/refs\/heads\/deploy\//, answer: () => ({ body: {} }) },
    {
      method: 'POST',
      path: '/graphql',
      answer: () =>
        failCommit ? { status: 502 } : { body: { data: { createCommitOnBranch: { commit: { oid: commit('e') } } } } },
    },
    {
      method: 'POST',
      path: `/repos/${repo}/pulls`,
      answer: () => ({ status: 201, body: { number: 70, html_url: 'u', node_id: 'n' } }),
    },
    { method: 'POST', path: /\/issues\/\d+\/labels$/, answer: () => ({ body: [] }) },
    { method: 'PATCH', path: /\/pulls\/\d+$/, answer: () => ({ body: {} }) },
  ];
  return { ...client(routes, sent), recover: () => (failCommit = false) };
}

/** GHCR: the factory built from c and b, its browser image not yet from c, and every pin built from a. */
function ghcr(revision = commit('a')): Registry {
  const built: Record<string, string[]> = {
    'mrogan/cv-software-factory/factory': ['a', 'b', 'c'].map(commit),
    'mrogan/cv-software-factory/factory-browser': ['a', 'b'].map(commit),
    'mrogan/cv-software-factory/factory-runner': ['a', 'b', 'c'].map(commit),
    'mrogan/cv-software-factory/console': ['a', 'c'].map(commit),
    'mrogan/cv-worlds-worst-website': ['a', 'b'].map(commit),
  };
  return {
    tags: async (image: string) => built[image] ?? [],
    digest: async (image: string) => digest(image.endsWith('browser') ? '8' : image.endsWith('runner') ? '6' : '7'),
    revision: async () => revision,
  } as unknown as Registry;
}

const writes = (sent: Sent[]) => calls(sent).filter((s) => s.method !== 'GET');

interface CommitInput {
  expectedHeadOid: string;
  message: { headline: string };
  fileChanges: { additions: { contents: string }[] };
}

const committed = (sent: Sent[]) => {
  const graphql = writes(sent).find((s) => s.path === '/graphql') as { body: { variables: { input: CommitInput } } };
  const input = graphql.body.variables.input;
  return { ...input, file: Buffer.from(input.fileChanges.additions[0]?.contents ?? '', 'base64').toString() };
};

const watch = (gh: ReturnType<typeof github>, target: DeployTarget, registry = ghcr(), actions?: Actions) =>
  deployWatch({ github: gh.github, registry, actions: actions ?? new LiveActions(gh.github), log: quiet }, target);

describe('the deploy watch', () => {
  it('proposes the newest commit every pinned image was built from, at the head it read, labelled', async () => {
    const gh = github(FACTORY);
    await watch(gh, FACTORY)();
    expect(writes(gh.sent).map((s) => `${s.method} ${s.path}`)).toEqual([
      `PATCH /repos/${FACTORY.repo}/git/refs/heads/deploy/factory-local`,
      'POST /graphql',
      `POST /repos/${FACTORY.repo}/pulls`,
      `POST /repos/${FACTORY.repo}/issues/70/labels`,
    ]);
    // The branch, the commit and the pin file all come from the one head of main.
    expect(writes(gh.sent)[0]?.body).toEqual({ sha: HEAD, force: true });
    const { expectedHeadOid, message, file } = committed(gh.sent);
    expect(expectedHeadOid).toBe(HEAD);
    expect(message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
    // Only the digests change, as text.
    expect(file).toBe(FACTORY_PIN.replace(digest('1'), digest('7')).replace(digest('2'), digest('8')));
    expect(writes(gh.sent)[2]?.body).toMatchObject({
      head: 'deploy/factory-local',
      base: 'main',
      title: message.headline,
    });
    expect((writes(gh.sent)[2] as { body: { body: string } }).body.body).toMatch(
      /^Pins `factory` \(ghcr\.io\/mrogan\/cv-software-factory\/factory@sha256:7{64}\) and `factory-browser` .* built from b{40}/,
    );
    expect(writes(gh.sent)[3]?.body).toEqual({ labels: ['deploy: local'] });
  });

  it('names the console and the app as their titles say', async () => {
    const console = github(CONSOLE, { pin: pinFile([['console', digest('1'), 'mrogan/cv-software-factory/console']]) });
    await watch(console, CONSOLE)();
    expect(committed(console.sent).message.headline).toBe('chore(deploy): run console ccccccc on the local cluster');
    const app = github(APP, { pin: pinFile([['website', digest('1'), 'mrogan/cv-worlds-worst-website']]) });
    await watch(app, APP)();
    expect(committed(app.sent).message.headline).toBe('chore(deploy): run bbbbbbb on the local cluster');
  });

  it('leaves out an image the pin file does not pin yet: the change that brings it in pins it', async () => {
    const target = {
      ...FACTORY,
      images: [...FACTORY.images, { name: 'later', image: 'mrogan/cv-software-factory/later' }],
    };
    const gh = github(target);
    await watch(gh, target)();
    expect(committed(gh.sent).message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
  });

  it('moves an open pull request for an older build, with its new title and body', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: label }],
    });
    await watch(gh, FACTORY)();
    const update = writes(gh.sent).at(-1);
    expect(update?.path).toBe(`/repos/${FACTORY.repo}/pulls/69`);
    expect(update?.body).toMatchObject({
      title: 'chore(deploy): run the factory bbbbbbb on the local cluster',
      body: expect.stringContaining(`built from ${commit('b')}`),
    });
  });

  it('leaves one already current, adding its label if an earlier pass did not get that far', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const gh = github(FACTORY, { pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: [] }] });
    await watch(gh, FACTORY)();
    expect(writes(gh.sent).map((s) => [s.path, s.body])).toEqual([
      [`/repos/${FACTORY.repo}/issues/69/labels`, { labels: ['deploy: local'] }],
    ]);
  });

  it('does not propose again a build whose pull request was closed without merging', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const gh = github(FACTORY, { pulls: [{ number: 68, title, state: 'closed', merged_at: null, labels: [] }] });
    await watch(gh, FACTORY)();
    expect(writes(gh.sent)).toEqual([]);
  });

  it('proposes nothing when the pin is the newest full build, or newer than any', async () => {
    for (const revision of [commit('b'), commit('d')]) {
      const gh = github(FACTORY);
      await watch(gh, FACTORY, ghcr(revision))();
      expect(writes(gh.sent)).toEqual([]);
    }
  });

  it('carries on after a failure partway: the next pass moves the branch again and opens the pull request', async () => {
    const gh = github(FACTORY, { failCommit: true });
    const pass = watch(gh, FACTORY);
    await expect(pass()).rejects.toMatchObject({ kind: 'server' });
    gh.recover();
    await pass();
    expect(writes(gh.sent).map((s) => `${s.method} ${s.path.split('/').at(-1)}`)).toEqual([
      'PATCH factory-local',
      'POST graphql',
      'PATCH factory-local',
      'POST graphql',
      'POST pulls',
      'POST labels',
    ]);
  });

  it('in a dry run, records the proposal once rather than every minute', async () => {
    const gh = github(FACTORY);
    const records: string[] = [];
    const store = {
      put: async (bytes: Uint8Array) => {
        records.push(JSON.parse(new TextDecoder().decode(bytes)).action);
        return String(records.length).padStart(64, 'f');
      },
    };
    const pass = watch(gh, FACTORY, ghcr(), new DryRunActions(store as never, quiet));
    await pass();
    await pass();
    expect(records).toEqual(['setBranch', 'commit', 'openPullRequest']);
    expect(writes(gh.sent)).toEqual([]);
  });
});

describe('the release watch', () => {
  const REPO = 'mrogan/cv-software-factory';
  function main() {
    let head = 'a';
    const { github: gh } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/git/ref/heads/main`,
        answer: () => ({ body: { object: { sha: commit(head) } } }),
      },
    ]);
    return {
      gh,
      move: (to: string) => {
        head = to;
      },
    };
  }

  it('runs release-please each time main moves, and not again until it does', async () => {
    const { gh, move } = main();
    let runs = 0;
    const pass = releaseWatch(gh, REPO, quiet, async () => {
      runs += 1;
      return { releases: [], pullRequests: [] };
    });
    await pass();
    await pass();
    move('b');
    await pass();
    expect(runs).toBe(2);
  });

  it('does not run again every minute after a run that failed, but does when main moves', async () => {
    const { gh, move } = main();
    let runs = 0;
    const pass = releaseWatch(gh, REPO, quiet, async () => {
      runs += 1;
      throw new Error('no release-please-config.json');
    });
    await expect(pass()).rejects.toThrow();
    await pass();
    move('b');
    await expect(pass()).rejects.toThrow();
    expect(runs).toBe(2);
  });
});
