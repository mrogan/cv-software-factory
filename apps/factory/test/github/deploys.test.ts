/**
 * The deploy and release watches, through the watch itself: a fake GitHub and GHCR, and what the watch does to them.
 */
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { type Actions, DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { ownsBranch } from '../../src/github/branches.ts';
import {
  carriesIn,
  carriesSection,
  DEPLOYS,
  DeployProposals,
  DeployRefused,
  type DeployTarget,
  deployBody,
  deployedImage,
  deployWatch,
  type Pin,
  SIGNING_GRACE_MS,
  scratchBranch,
  withCarries,
} from '../../src/github/deploys.ts';
import { type Registry, RegistryError } from '../../src/github/registry.ts';
import { releaseWatch } from '../../src/github/releases.ts';
import { pipeline, type Signatures, type Signer, UnsignedError } from '../../src/github/signatures.ts';
import { calls, client, quiet, type Route, type Sent } from './fake.ts';

const [FACTORY, APP] = DEPLOYS as [DeployTarget, DeployTarget];
const [CONSOLE_PIN, FACTORY_PINS] = FACTORY.pins as [Pin, Pin];
const [APP_PIN] = APP.pins as [Pin];
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
  ['factory', digest('1'), 'the-roganator/cv-software-factory/factory'],
  ['factory-browser', digest('2'), 'the-roganator/cv-software-factory/factory-browser'],
]);
const CONSOLE_PIN_FILE = pinFile([['console', digest('3'), 'the-roganator/cv-software-factory/console']]);
const APP_PIN_FILE = pinFile([['website', digest('1'), 'the-roganator/cv-worlds-worst-website']]);
const BOTH = { [CONSOLE_PIN.file]: CONSOLE_PIN_FILE, [FACTORY_PINS.file]: FACTORY_PIN };
const CONSOLE_TITLE = 'chore(deploy): run console ccccccc on the local cluster';
const BOTH_TITLE = 'chore(deploy): run console ccccccc and the factory bbbbbbb on the local cluster';
/** A pin file that pins nothing yet, so it has no newer build. */
const NO_PINS = 'apiVersion: kustomize.config.k8s.io/v1alpha1\nkind: Component\n';

interface Pull {
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged_at: string | null;
  labels: { name: string }[];
  body?: string | null;
}

/**
 * GitHub with main at d, then c, b, a; the pin files at main's head (the factory's alone, unless it is told others); and the deploy branch's pull requests, each with its
 * head at the deploy branch and approved or not. It keeps the branches and the commit each was made on, and closes an
 * open pull request whose branch is moved to main's head, with nothing left to merge, as GitHub does. Main can move
 * on to a commit no image was built from.
 */
function github(
  target: DeployTarget,
  options: { pins?: Record<string, string>; pulls?: Pull[]; failCommit?: boolean; approved?: boolean } = {},
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
      path: /\/contents\/.+\?ref=/,
      answer: ({ path }) => {
        expect(path.endsWith(`?ref=${main}`)).toBe(true);
        const file = path.replace(/^.*\/contents\//, '').replace(/\?.*$/, '');
        const pins = options.pins ?? { [FACTORY_PINS.file]: FACTORY_PIN };
        return { body: { content: Buffer.from(pins[file] ?? NO_PINS).toString('base64') } };
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

/** GHCR: the factory built from c and b, its browser image not yet from c, the console from c, and every pin from a. */
function ghcr(revision: string | ((image: string) => string) = commit('a')): Registry {
  const built: Record<string, string[]> = {
    'the-roganator/cv-software-factory/factory': ['a', 'b', 'c'].map(commit),
    'the-roganator/cv-software-factory/factory-browser': ['a', 'b'].map(commit),
    'the-roganator/cv-software-factory/factory-runner': ['a', 'b', 'c'].map(commit),
    'the-roganator/cv-software-factory/console': ['a', 'c'].map(commit),
    'the-roganator/cv-worlds-worst-website': ['a', 'b'].map(commit),
  };
  return {
    tags: async (image: string) => built[image] ?? [],
    digest: async (image: string) => digest(image.endsWith('browser') ? '8' : image.endsWith('runner') ? '6' : '7'),
    revision: async (image: string) => (typeof revision === 'string' ? revision : revision(image)),
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
  fileChanges: { additions: { path: string; contents: string }[] };
}

const committed = (sent: Sent[]) => {
  const graphql = writes(sent).find((s) => s.path === '/graphql') as { body: { variables: { input: CommitInput } } };
  const input = graphql.body.variables.input;
  const files = input.fileChanges.additions.map((a) => [a.path, Buffer.from(a.contents, 'base64').toString()]);
  return { ...input, files: Object.fromEntries(files), file: files[0]?.[1] ?? '' };
};

/** Signature checks that pass for every digest but those named, and keep what they were asked. */
function signatures(unsigned: string[] = [], refused: string[] = []) {
  const asked: [image: string, digest: string, signer: Signer][] = [];
  const check: Pick<Signatures, 'verify'> = {
    verify: async (image, digest, signer) => {
      asked.push([image, digest, signer]);
      if (unsigned.includes(digest)) throw new UnsignedError('unsigned', `${image}@${digest} has no signature`);
      if (refused.includes(digest)) throw new UnsignedError('refused', `${image}@${digest} has no signature by them`);
    },
  };
  return { check, asked, unsigned };
}

const watch = (
  gh: ReturnType<typeof github>,
  target: DeployTarget,
  registry = ghcr(),
  actions?: Actions,
  { check }: { check: Pick<Signatures, 'verify'> } = signatures(),
  log = quiet,
  now = Date.now,
  proposals?: DeployProposals,
) =>
  deployWatch(
    {
      github: gh.github,
      registry,
      signatures: check,
      actions: actions ?? new LiveActions(gh.github),
      log,
      now,
      ...(proposals ? { proposals } : {}),
    },
    target,
  );

describe('the deploy watch', () => {
  it('proposes the newest commit every pinned image was built from, at the head it read, labelled', async () => {
    const gh = github(FACTORY);
    await watch(gh, FACTORY)();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
      'POST pulls',
      'POST issues/70/labels',
    ]);
    // The scratch branch, the commit and the pin file all come from the one head of main.
    expect(writes(gh.sent)[0]?.body).toEqual({ ref: 'refs/heads/factory/deploy/local', sha: HEAD });
    const { branch, expectedHeadOid, message, file } = committed(gh.sent);
    expect(branch.branchName).toBe('factory/deploy/local');
    expect(expectedHeadOid).toBe(HEAD);
    // The deploy branch goes to the commit, and the scratch branch is gone.
    expect(writes(gh.sent)[2]?.body).toEqual({ sha: commit('e'), force: true });
    expect([...gh.branches]).toEqual([['deploy/local', commit('e')]]);
    expect(message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
    // Only the digests change, as text.
    expect(file).toBe(FACTORY_PIN.replace(digest('1'), digest('7')).replace(digest('2'), digest('8')));
    expect(writes(gh.sent)[4]?.body).toMatchObject({
      head: 'deploy/local',
      base: 'main',
      title: message.headline,
    });
    const url = 'https://github.com/the-roganator/cv-software-factory';
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
    const body = deployBody(APP, [
      {
        pin: APP_PIN,
        proposal: { commit: commit('c'), digests: APP_PIN.images.map((i) => ({ ...i, digest: digest('9') })) },
      },
    ]);
    expect(body).toBe(
      `Runs [\`ccccccc\`](https://github.com/the-roganator/cv-worlds-worst-website/commit/${commit('c')}) on the local cluster.

| Image | Digest |
|---|---|
| \`website\` | \`sha256:999999999999…\` |

Argo CD deploys it from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.`,
    );
  });

  it('names the console and the app as their titles say', async () => {
    const console = github(FACTORY, { pins: { [CONSOLE_PIN.file]: CONSOLE_PIN_FILE } });
    await watch(console, FACTORY)();
    expect(committed(console.sent).message.headline).toBe('chore(deploy): run console ccccccc on the local cluster');
    expect(Object.keys(committed(console.sent).files)).toEqual([CONSOLE_PIN.file]);
    const app = github(APP, { pins: { [APP_PIN.file]: APP_PIN_FILE } });
    await watch(app, APP)();
    expect(committed(app.sent).message.headline).toBe('chore(deploy): run bbbbbbb on the local cluster');
  });

  it('leaves out an image the pin file does not pin yet: the change that brings it in pins it', async () => {
    const later = {
      ...FACTORY_PINS,
      images: [...FACTORY_PINS.images, { name: 'later', image: 'the-roganator/cv-software-factory/later' }],
    };
    const target = { ...FACTORY, pins: [CONSOLE_PIN, later] };
    const gh = github(target);
    await watch(gh, target)();
    expect(committed(gh.sent).message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
  });

  it('moves both pin files in one commit and one pull request when both have a newer build, each at its own commit', async () => {
    const gh = github(FACTORY, { pins: BOTH });
    await watch(gh, FACTORY)();
    expect(steps(gh.sent)).toEqual([
      'POST git/refs',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
      'POST pulls',
      'POST issues/70/labels',
    ]);
    const { message, files } = committed(gh.sent);
    expect(message.headline).toBe(BOTH_TITLE);
    expect(files).toEqual({
      [CONSOLE_PIN.file]: CONSOLE_PIN_FILE.replace(digest('3'), digest('7')),
      [FACTORY_PINS.file]: FACTORY_PIN.replace(digest('1'), digest('7')).replace(digest('2'), digest('8')),
    });
    const url = 'https://github.com/the-roganator/cv-software-factory';
    expect((writes(gh.sent)[4] as { body: { body: string } }).body.body).toBe(
      `Runs on the local cluster:

- console at [\`ccccccc\`](${url}/commit/${commit('c')}): [the changes since \`aaaaaaa\`](${url}/compare/${commit('a')}...${commit('c')})
- the factory at [\`bbbbbbb\`](${url}/commit/${commit('b')}): [the changes since \`aaaaaaa\`](${url}/compare/${commit('a')}...${commit('b')})

| Image | Digest |
|---|---|
| \`console\` | \`sha256:777777777777…\` |
| \`factory\` | \`sha256:777777777777…\` |
| \`factory-browser\` | \`sha256:888888888888…\` |

Argo CD deploys them from \`deploy/overlays/local\` once this merges. A newer build moves this pull request on rather than opening another.`,
    );
  });

  it('moves the pull request for one pin file on to both when the other’s build lands, keeping its number', async () => {
    const gh = github(FACTORY, {
      pins: BOTH,
      pulls: [
        { number: 69, title: CONSOLE_TITLE, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] },
      ],
    });
    await watch(gh, FACTORY)();
    expect(steps(gh.sent)).not.toContain('POST pulls');
    expect(writes(gh.sent).at(-1)).toMatchObject({
      path: `/repos/${FACTORY.repo}/pulls/69`,
      body: { title: BOTH_TITLE },
    });
    expect(Object.keys(committed(gh.sent).files)).toEqual([CONSOLE_PIN.file, FACTORY_PINS.file]);
    expect(gh.pulls[0]?.state).toBe('open');
  });

  it('moves the pull request for both on to the one left when the other’s pin merges by other means', async () => {
    const gh = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 69, title: BOTH_TITLE, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    // The console's pin on main is its newest build already.
    await watch(
      gh,
      FACTORY,
      ghcr((image) => commit(image.endsWith('console') ? 'c' : 'a')),
    )();
    expect(writes(gh.sent).at(-1)).toMatchObject({
      path: `/repos/${FACTORY.repo}/pulls/69`,
      body: { title: 'chore(deploy): run the factory bbbbbbb on the local cluster' },
    });
    expect(Object.keys(committed(gh.sent).files)).toEqual([FACTORY_PINS.file]);
  });

  it('does not propose again a build closed beside another, nor alone, but does the other pin file’s', async () => {
    const both = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 68, title: BOTH_TITLE, state: 'closed', merged_at: null, labels: [] }],
    });
    await watch(both, FACTORY)();
    expect(writes(both.sent)).toEqual([]);
    const alone = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 68, title: CONSOLE_TITLE, state: 'closed', merged_at: null, labels: [] }],
    });
    await watch(alone, FACTORY)();
    expect(committed(alone.sent).message.headline).toBe('chore(deploy): run the factory bbbbbbb on the local cluster');
    // A merged one is no refusal.
    const merged = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 68, title: CONSOLE_TITLE, state: 'closed', merged_at: '2026-10-22T08:00:00Z', labels: [] }],
    });
    await watch(merged, FACTORY)();
    expect(committed(merged.sent).message.headline).toBe(BOTH_TITLE);
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
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
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
      'PATCH git/refs/heads/factory/deploy/local',
      'POST graphql',
      'PATCH git/refs/heads/deploy/local',
      'DELETE git/refs/heads/factory/deploy/local',
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

describe('the deploy watch and signatures', () => {
  it('asks that every image carry the signature of build.yml on main of the repository that built it', async () => {
    const signed = signatures();
    const gh = github(FACTORY);
    await watch(gh, FACTORY, ghcr(), undefined, signed)();
    expect(signed.asked).toEqual([
      ['the-roganator/cv-software-factory/factory', digest('7'), pipeline('the-roganator/cv-software-factory')],
      ['the-roganator/cv-software-factory/factory-browser', digest('8'), pipeline('the-roganator/cv-software-factory')],
    ]);
    expect(steps(gh.sent)).toContain('POST pulls');
    const app = github(APP, { pins: { [APP_PIN.file]: APP_PIN_FILE } });
    await watch(app, APP, ghcr(), undefined, signed)();
    expect(signed.asked.at(-1)?.[2]).toEqual(pipeline('the-roganator/cv-worlds-worst-website'));
  });

  /** A log that keeps what it was told, at info and above. */
  const kept = () => {
    const lines: { level: number; msg: string; digest?: string; reason?: string }[] = [];
    return { lines, log: pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) }) };
  };

  it('waits for a build its pipeline has not signed yet, and proposes it once it has', async () => {
    const signed = signatures([digest('8')]);
    const { lines, log } = kept();
    const gh = github(FACTORY);
    const pass = watch(gh, FACTORY, ghcr(), undefined, signed, log);
    await pass();
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    expect(lines).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'waiting for a build to be signed before proposing it',
        digest: digest('8'),
        reason: `the-roganator/cv-software-factory/factory-browser@${digest('8')} has no signature`,
      }),
    ]);
    signed.unsigned.length = 0;
    await pass();
    expect(steps(gh.sent)).toContain('POST pulls');
  });

  it('warns, once, of a build still unsigned when its signing should long have finished, and never proposes it', async () => {
    let clock = 0;
    const { lines, log } = kept();
    const gh = github(FACTORY);
    const pass = watch(gh, FACTORY, ghcr(), undefined, signatures([digest('8')]), log, () => clock);
    await pass();
    clock = SIGNING_GRACE_MS - 1;
    await pass();
    expect(lines.map((l) => l.level)).toEqual([30]);
    clock = SIGNING_GRACE_MS;
    await pass();
    await pass();
    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      [30, 'waiting for a build to be signed before proposing it'],
      [40, 'did not propose a build its pipeline did not sign'],
    ]);
    expect(writes(gh.sent)).toEqual([]);
  });

  it('waits for one pin file’s build to be signed before proposing the other’s, and goes without it once it is late', async () => {
    let clock = 0;
    const gh = github(FACTORY, { pins: BOTH });
    const pass = watch(gh, FACTORY, ghcr(), undefined, signatures([digest('8')]), quiet, () => clock);
    await pass();
    expect(writes(gh.sent)).toEqual([]);
    clock = SIGNING_GRACE_MS;
    await pass();
    expect(committed(gh.sent).message.headline).toBe(CONSOLE_TITLE);
  });

  it('leaves the pull request as it is while it runs an older build of a pin file whose newest was refused', async () => {
    const gh = github(FACTORY, {
      pins: BOTH,
      pulls: [{ number: 69, title: BOTH_TITLE, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    // The factory's newest build, b, is signed by someone else: the pull request keeps the factory at the one it runs.
    await watch(gh, FACTORY, ghcr(), undefined, signatures([], [digest('8')]))();
    expect(writes(gh.sent)).toEqual([]);
  });

  it('reads main’s commits once a pass, however many pin files it reads', async () => {
    const gh = github(FACTORY, { pins: BOTH });
    await watch(gh, FACTORY)();
    expect(calls(gh.sent).filter((c) => c.path.includes('/commits?'))).toHaveLength(1);
  });

  it('warns at once, and once, of a build signed by anyone but its pipeline', async () => {
    const { lines, log } = kept();
    const gh = github(FACTORY);
    const pass = watch(gh, FACTORY, ghcr(), undefined, signatures([], [digest('7')]), log);
    await pass();
    await pass();
    expect(lines).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'did not propose a build its pipeline did not sign',
        digest: digest('7'),
        reason: `the-roganator/cv-software-factory/factory@${digest('7')} has no signature by them`,
      }),
    ]);
    expect(writes(gh.sent)).toEqual([]);
  });

  it('fails the pass when a signature cannot be checked: that is not the same as unsigned', async () => {
    const gh = github(FACTORY);
    const unreachable: Pick<Signatures, 'verify'> = {
      verify: async () => {
        throw new RegistryError('ghcr.io answered 503', 503);
      },
    };
    await expect(watch(gh, FACTORY, ghcr(), undefined, { check: unreachable })()).rejects.toBeInstanceOf(RegistryError);
    expect(writes(gh.sent)).toEqual([]);
  });
});

describe('the release watch', () => {
  const REPO = 'the-roganator/cv-software-factory';
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

describe('what a deploy carries', () => {
  const carried = [
    { workItem: '1001', title: 'Redirect loop on /departments/:department', issue: 16, pullRequest: 17 },
    { workItem: '1006', title: 'Prices | totals <b>@mrogan</b> [x](y) `z` & co', issue: null, pullRequest: 25 },
  ];

  it('lists each work item with its ticket, issue and pull request, with nothing in a title read as markup', () => {
    expect(carriesSection(carried).split('\n')).toEqual([
      '<!-- factory: carries -->',
      '### Carries',
      '',
      'It carries 2 work items of the line’s, whose fixes merged since the pinned commit:',
      '',
      '| Ticket | Title | Issue | Pull request |',
      '|---|---|---|---|',
      '| 1001 | Redirect loop on /departments/\\:department | #16 | #17 |',
      '| 1006 | Prices \\| totals &lt;b&gt;&#64;mrogan&lt;/b&gt; \\[x\\](y) \\`z\\` &amp; co | – | #25 |',
      '<!-- factory: /carries -->',
    ]);
    expect(carriesSection([])).toContain('It carries none of the line’s work items');
    const counted = carriesSection(carried.slice(0, 1), 3);
    expect(counted).toContain('It carries 4 work items');
    expect(counted).toContain('| | and 3 more | | |');
  });

  it('replaces the section a body has, or adds one, and finds it again', () => {
    const body = 'Runs `bbbbbbb` on the local cluster.';
    const once = withCarries(body, carriesSection(carried));
    expect(once.startsWith(`${body}\n\n<!-- factory: carries -->`)).toBe(true);
    expect(carriesIn(once)).toBe(carriesSection(carried));
    const twice = withCarries(once, carriesSection([]));
    expect(twice).toBe(`${body}\n\n${carriesSection([])}`);
    expect(carriesIn(body)).toBeUndefined();
    expect(carriesIn(null)).toBeUndefined();
  });

  it('keeps what the line said when the watch moves the pull request to a newer build', async () => {
    const older = 'chore(deploy): run the factory aaaaaaa on the local cluster';
    const section = carriesSection(carried);
    const gh = github(FACTORY, {
      pulls: [
        {
          number: 69,
          title: older,
          state: 'open',
          merged_at: null,
          labels: [{ name: 'deploy: local' }],
          body: `Runs \`aaaaaaa\` on the local cluster.\n\n${section}`,
        },
      ],
    });
    await watch(gh, FACTORY)();
    const { body } = (writes(gh.sent).at(-1) as { body: { body: string } }).body;
    expect(body).toContain(`/commit/${commit('b')})`);
    expect(body).not.toContain('Runs `aaaaaaa`');
    expect(
      body.endsWith(
        `once this merges. A newer build moves this pull request on rather than opening another.\n\n${section}`,
      ),
    ).toBe(true);
    // One the line never described is moved with no section.
    const bare = github(FACTORY, {
      pulls: [{ number: 69, title: older, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    await watch(bare, FACTORY)();
    expect(carriesIn((writes(bare.sent).at(-1) as { body: { body: string } }).body.body)).toBeUndefined();
  });

  it('remembers the app’s open pull request for the line to read, and forgets it once it merges', async () => {
    const proposals = new DeployProposals();
    const pins = { [APP_PIN.file]: APP_PIN_FILE };
    const gh = github(APP, { pins });
    await watch(gh, APP, ghcr(), undefined, signatures(), quiet, Date.now, proposals)();
    expect(proposals.get(APP.repo, APP.branch)).toEqual({
      number: 70,
      commit: commit('b'),
      pinned: commit('a'),
      digests: [{ name: 'website', image: 'the-roganator/cv-worlds-worst-website', digest: digest('7') }],
    });
    expect(proposals.get(FACTORY.repo, APP.branch)).toBeNull();
    // A worker started again learns of the open one on its first pass.
    const title = 'chore(deploy): run bbbbbbb on the local cluster';
    const again = new DeployProposals();
    const open = github(APP, {
      pins,
      pulls: [{ number: 69, title, state: 'open', merged_at: null, labels: [{ name: 'deploy: local' }] }],
    });
    await watch(open, APP, ghcr(), undefined, signatures(), quiet, Date.now, again)();
    expect(again.get(APP.repo, APP.branch)).toMatchObject({ number: 69, commit: commit('b') });
    // Merged: the pin is the newest build.
    await watch(open, APP, ghcr(commit('b')), undefined, signatures(), quiet, Date.now, again)();
    expect(again.get(APP.repo, APP.branch)).toBeNull();
  });

  it('keeps no range for a deploy of several pin files, which has none', async () => {
    const proposals = new DeployProposals();
    await watch(github(FACTORY), FACTORY, ghcr(), undefined, signatures(), quiet, Date.now, proposals)();
    expect(proposals.get(FACTORY.repo, FACTORY.branch)).toBeNull();
  });
});

describe('the images a repository deploys', () => {
  it("knows a deployed image only under the repository's owner", () => {
    const repo = 'the-roganator/cv-worlds-worst-website';
    expect(deployedImage(repo, 'the-roganator/cv-worlds-worst-website')).toBe('the-roganator/cv-worlds-worst-website');
    for (const image of [
      'mrogan/cv-worlds-worst-website',
      'someone/cv-worlds-worst-website',
      'the-roganator/cv-software-factory/factory',
      'mrogan/cv-software-factory/factory',
    ]) {
      expect(() => deployedImage(repo, image)).toThrow(DeployRefused);
    }
  });
});
