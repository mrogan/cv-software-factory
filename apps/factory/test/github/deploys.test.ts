/**
 * The deploy and release watches, through the watch itself: a fake GitHub and GHCR, and what the watch does to them.
 */
import { describe, expect, it } from 'vitest';
import { type Actions, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { ownsBranch } from '../../src/github/branches.ts';
import { DEPLOYS, type DeployTarget, deployBody, deployWatch, scratchBranch } from '../../src/github/deploys.ts';
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

/**
 * GitHub with main at d, then c, b, a; a pin file at main's head; and the deploy branch's pull requests, each with its
 * head at the deploy branch and approved or not. It keeps the branches and the commit each was made on, and closes an
 * open pull request whose branch is moved to main's head, with nothing left to merge, as GitHub does. Main can move
 * on to a commit no image was built from.
 */
function github(
  target: DeployTarget,
  options: { pin?: string; pulls?: Pull[]; failCommit?: boolean; approved?: boolean } = {},
) {
  const { repo } = target;
  const sent: Sent[] = [];
  let failCommit = options.failCommit ?? false;
  let main = HEAD;
  const pulls = (options.pulls ?? []).map((p) => ({ ...p }));
  // The deploy branch is where the older build's commit left it, on main's head.
  const branches = new Map([[target.branch, commit('f')]]);
  const parents = new Map([[commit('f'), HEAD]]);
  // The commits the pins are made as, in turn.
  const made = ['e', '9', '8'].map(commit);
  const branchOf = (path: string) => decodeURIComponent(path.replace(/^.*\/git\/refs?\/heads\//, ''));
  const move = (branch: string, sha: string) => {
    branches.set(branch, sha);
    if (branch === target.branch && sha === main) {
      for (const p of pulls) if (p.state === 'open') p.state = 'closed';
    }
  };
  const routes: Route[] = [
    { method: 'GET', path: `/repos/${repo}/git/ref/heads/main`, answer: () => ({ body: { object: { sha: main } } }) },
    {
      method: 'GET',
      path: new RegExp(`/contents/${target.file}\\?ref=`),
      answer: ({ path }) => {
        expect(path.endsWith(`?ref=${main}`)).toBe(true);
        return { body: { content: Buffer.from(options.pin ?? FACTORY_PIN).toString('base64') } };
      },
    },
    {
      method: 'GET',
      path: `/repos/${repo}/commits?sha=${HEAD}&per_page=100`,
      answer: () => ({ body: ['d', 'c', 'b', 'a'].map((c) => ({ sha: commit(c) })) }),
    },
    {
      method: 'GET',
      path: `/repos/${repo}/commits?sha=${commit('0')}&per_page=100`,
      answer: () => ({ body: ['0', 'd', 'c', 'b', 'a'].map((c) => ({ sha: commit(c) })) }),
    },
    {
      method: 'GET',
      path: /\/pulls\?state=all/,
      answer: () => ({ body: pulls.map((p) => ({ ...p, head: { sha: branches.get(target.branch) } })) }),
    },
    {
      method: 'GET',
      path: /\/compare\//,
      answer: ({ path }) => {
        const [base, head] = path.replace(/^.*\/compare\//, '').split('...');
        // One commit on main is all a deploy branch holds; one made on an older head is a commit behind.
        return { body: { behind_by: parents.get(head ?? '') === base ? 0 : 1 } };
      },
    },
    {
      method: 'GET',
      path: /\/pulls\/\d+\/reviews/,
      answer: () => ({ body: options.approved ? [{ state: 'APPROVED' }] : [] }),
    },
    {
      method: 'GET',
      path: /\/git\/ref\/heads\//,
      answer: ({ path }) => {
        const sha = branches.get(branchOf(path));
        return sha ? { body: { object: { sha } } } : { status: 404, body: { message: 'Not Found' } };
      },
    },
    {
      method: 'PATCH',
      path: /\/git\/refs\/heads\//,
      answer: ({ path, body }) => {
        move(branchOf(path), (body as { sha: string }).sha);
        return { body: {} };
      },
    },
    {
      method: 'POST',
      path: `/repos/${repo}/git/refs`,
      answer: ({ body }) => {
        const { ref, sha } = body as { ref: string; sha: string };
        move(ref.replace(/^refs\/heads\//, ''), sha);
        return { status: 201, body: {} };
      },
    },
    {
      method: 'DELETE',
      path: /\/git\/refs\/heads\//,
      answer: ({ path }) => {
        branches.delete(branchOf(path));
        return { status: 204 };
      },
    },
    {
      method: 'POST',
      path: '/graphql',
      answer: ({ body }) => {
        if (failCommit) return { status: 502 };
        const { branch, expectedHeadOid } = (body as { variables: { input: CommitInput } }).variables.input;
        // GitHub commits only on a branch that is where the caller expects it.
        if (branches.get(branch.branchName) !== expectedHeadOid) return { body: { errors: [{ message: 'moved' }] } };
        const oid = made.shift() as string;
        parents.set(oid, expectedHeadOid);
        move(branch.branchName, oid);
        return { body: { data: { createCommitOnBranch: { commit: { oid } } } } };
      },
    },
    {
      method: 'POST',
      path: `/repos/${repo}/pulls`,
      answer: () => ({ status: 201, body: { number: 70, html_url: 'u', node_id: 'n' } }),
    },
    { method: 'POST', path: /\/issues\/\d+\/labels$/, answer: () => ({ body: [] }) },
    { method: 'PATCH', path: /\/pulls\/\d+$/, answer: () => ({ body: {} }) },
  ];
  return {
    ...client(routes, sent),
    pulls,
    branches,
    recover: () => (failCommit = false),
    // A merge that built no image.
    moveMain: () => (main = commit('0')),
  };
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

/** Each write, as its method and its path within the repository. */
const steps = (sent: Sent[]) =>
  writes(sent).map((s) => `${s.method} ${s.path.replace(/^\/repos\/[^/]+\/[^/]+\//, '').replace(/^\//, '')}`);

interface CommitInput {
  branch: { branchName: string };
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
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/factory-local',
      'DELETE git/refs/heads/factory/deploy/factory-local',
      'POST pulls',
      'POST issues/70/labels',
    ]);
    // The scratch branch, the commit and the pin file all come from the one head of main.
    expect(writes(gh.sent)[0]?.body).toEqual({ ref: 'refs/heads/factory/deploy/factory-local', sha: HEAD });
    const { branch, expectedHeadOid, message, file } = committed(gh.sent);
    expect(branch.branchName).toBe('factory/deploy/factory-local');
    expect(expectedHeadOid).toBe(HEAD);
    // The deploy branch goes to the commit, and the scratch branch is gone.
    expect(writes(gh.sent)[2]?.body).toEqual({ sha: commit('e'), force: true });
    expect([...gh.branches]).toEqual([['deploy/factory-local', commit('e')]]);
    expect(message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
    // Only the digests change, as text.
    expect(file).toBe(FACTORY_PIN.replace(digest('1'), digest('7')).replace(digest('2'), digest('8')));
    expect(writes(gh.sent)[4]?.body).toMatchObject({
      head: 'deploy/factory-local',
      base: 'main',
      title: message.headline,
    });
    const url = 'https://github.com/mrogan/cv-software-factory';
    expect((writes(gh.sent)[4] as { body: { body: string } }).body.body).toBe(
      `Runs [\`bbbbbbb\`](${url}/commit/${commit('b')}) on the local cluster: [the changes since \`aaaaaaa\`](${url}/compare/${commit('a')}...${commit('b')}).

| Image | Digest |
|---|---|
| \`factory\` | \`sha256:777777777777…\` |
| \`factory-browser\` | \`sha256:888888888888…\` |

Argo CD deploys them from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.`,
    );
    expect(writes(gh.sent)[5]?.body).toEqual({ labels: ['deploy: local'] });
  });

  it('describes one image, with no changes link when the pinned commit is not known', () => {
    const app = DEPLOYS.find((d) => d.repo === 'mrogan/cv-worlds-worst-website') as DeployTarget;
    const body = deployBody(app, {
      commit: commit('c'),
      digests: app.images.map((i) => ({ ...i, digest: digest('9') })),
    });
    expect(body).toBe(
      `Runs [\`ccccccc\`](https://github.com/mrogan/cv-worlds-worst-website/commit/${commit('c')}) on the local cluster.

| Image | Digest |
|---|---|
| \`website\` | \`sha256:999999999999…\` |

Argo CD deploys it from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.`,
    );
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
      body: expect.stringContaining(`/commit/${commit('b')})`),
    });
  });

  it('moves the deploy branch from the older build straight to the newer, so GitHub never closes its pull request', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    await watch(gh, FACTORY)();
    // At main's head, the branch would have nothing to merge, and GitHub would close the pull request as the App.
    const deployBranch = writes(gh.sent).filter((s) => s.path.endsWith(`/heads/${FACTORY.branch}`));
    expect(deployBranch.map((s) => s.body)).toEqual([{ sha: commit('e'), force: true }]);
    expect(gh.pulls[0]?.state).toBe('open');
    expect(gh.branches.get(FACTORY.branch)).toBe(commit('e'));
    expect(steps(gh.sent)).not.toContain('POST pulls');
  });

  it('commits on a branch the factory owns, which nothing else of the line uses', () => {
    for (const target of DEPLOYS) {
      expect(ownsBranch(scratchBranch(target))).toBe(true);
      expect(scratchBranch(target)).not.toBe(target.branch);
    }
  });

  it('leaves one already current, adding its label if an earlier pass did not get that far', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const gh = github(FACTORY, { pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: [] }] });
    await watch(gh, FACTORY)();
    expect(writes(gh.sent).map((s) => [s.path, s.body])).toEqual([
      [`/repos/${FACTORY.repo}/issues/69/labels`, { labels: ['deploy: local'] }],
    ]);
  });

  it('makes its commit again on main’s new head when main moves on with no newer build, keeping its pull request', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const gh = github(FACTORY, { pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: label }] });
    const pass = watch(gh, FACTORY);
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    gh.moveMain();
    await pass();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/factory-local',
      'DELETE git/refs/heads/factory/deploy/factory-local',
    ]);
    const { expectedHeadOid, message } = committed(gh.sent);
    expect(expectedHeadOid).toBe(commit('0'));
    expect(message.headline).toBe(title);
    // Straight from the commit on the old head to the one on the new: the pull request stays open, one commit on main.
    expect(writes(gh.sent)[2]?.body).toEqual({ sha: commit('e'), force: true });
    expect(gh.pulls[0]?.state).toBe('open');
    // Current now, so the next pass leaves it.
    await pass();
    expect(writes(gh.sent)).toHaveLength(4);
  });

  it('leaves a deploy pull request Martin has approved behind main: a push would make his approval stale', async () => {
    const title = 'chore(deploy): run the factory bbbbbbb on the local cluster';
    const label = [{ name: 'deploy: local' }];
    const gh = github(FACTORY, {
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: label }],
      approved: true,
    });
    gh.moveMain();
    await watch(gh, FACTORY)();
    expect(writes(gh.sent)).toEqual([]);
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

  it('carries on after a failure partway: the next pass starts the scratch branch again and opens the pull request', async () => {
    const gh = github(FACTORY, { failCommit: true });
    const pass = watch(gh, FACTORY);
    await expect(pass()).rejects.toMatchObject({ kind: 'server' });
    // The deploy branch has not moved.
    expect(gh.branches.get(FACTORY.branch)).toBe(commit('f'));
    gh.recover();
    await pass();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      // The scratch branch the failed pass left is moved back to main's head.
      'PATCH git/refs/heads/factory/deploy/factory-local',
      'POST graphql',
      'PATCH git/refs/heads/deploy/factory-local',
      'DELETE git/refs/heads/factory/deploy/factory-local',
      'POST pulls',
      'POST issues/70/labels',
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
    const actions = new DryRunActions(store as never, quiet);
    const pass = watch(gh, FACTORY, ghcr(), actions);
    await pass();
    await pass();
    // Nor again as main moves on: GitHub has no pull request of the dry run's to bring up to date.
    gh.moveMain();
    await pass();
    expect(records).toEqual(['setBranch', 'commit', 'setBranch', 'deleteBranch', 'openPullRequest']);
    expect(writes(gh.sent)).toEqual([]);
    // Its reads find the deploy branch at the commit it would have made on main's head, and no scratch branch.
    const made = actions.branchMade(FACTORY.repo, FACTORY.branch) as string;
    expect(actions.commitMade(made)?.parent).toBe(HEAD);
    expect(actions.branchMade(FACTORY.repo, scratchBranch(FACTORY))).toBeUndefined();
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
