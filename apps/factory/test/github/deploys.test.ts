import { describe, expect, it } from 'vitest';
import { DryRunActions, LiveActions } from '../../src/github/actions.ts';
import { DEPLOYS, deployBody, deployTitle, deployWatch, pinned, repin } from '../../src/github/deploys.ts';
import type { Registry } from '../../src/github/registry.ts';
import { releaseWatch } from '../../src/github/releases.ts';
import { calls, client, quiet, type Route } from './fake.ts';

const [CONSOLE, FACTORY] = DEPLOYS as [(typeof DEPLOYS)[0], (typeof DEPLOYS)[0]];
const REPO = 'mrogan/cv-software-factory';
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const commit = (c: string) => c.repeat(40);

const PIN = `apiVersion: kustomize.config.k8s.io/v1alpha1
kind: Component
resources:
- ../../../base/factory
images:
- digest: ${digest('1')}
  name: factory
  newName: ghcr.io/mrogan/cv-software-factory/factory
- digest: ${digest('2')}
  name: factory-browser
  newName: ghcr.io/mrogan/cv-software-factory/factory-browser
`;

describe('a pin file', () => {
  it('is read by image name, and moved digest by digest with its layout kept', () => {
    expect(pinned(PIN)).toEqual(
      new Map([
        ['factory', digest('1')],
        ['factory-browser', digest('2')],
      ]),
    );
    const next = repin(PIN, {
      commit: commit('c'),
      digests: [
        { name: 'factory', image: 'x', digest: digest('3') },
        { name: 'factory-browser', image: 'y', digest: digest('4') },
      ],
    });
    expect(next).toBe(PIN.replace(digest('1'), digest('3')).replace(digest('2'), digest('4')));
  });

  it('gives the title the build workflow reads back, and a body that names each image', () => {
    expect(deployTitle(CONSOLE, commit('a'))).toBe('chore(deploy): run console aaaaaaa on the local cluster');
    expect(deployTitle(DEPLOYS[2] as (typeof DEPLOYS)[0], commit('a'))).toBe(
      'chore(deploy): run aaaaaaa on the local cluster',
    );
    expect(
      deployBody(FACTORY, {
        commit: commit('c'),
        digests: [
          { name: 'factory', image: 'mrogan/cv-software-factory/factory', digest: digest('3') },
          { name: 'factory-browser', image: 'mrogan/cv-software-factory/factory-browser', digest: digest('4') },
        ],
      }),
    ).toMatch(
      /^Pins `factory` \(ghcr\.io\/mrogan\/cv-software-factory\/factory@sha256:3{64}\) and `factory-browser` .*, built from c{40}, in `deploy\/overlays\/local`\. Argo CD deploys them/,
    );
  });
});

/** GitHub with main at commits d (newest), c, b, a, the pin file, and the deploy branch's open pull requests. */
function world(options: { pin?: string; open?: { number: number; title: string }[] } = {}) {
  const routes: Route[] = [
    {
      method: 'GET',
      path: `/repos/${REPO}/contents/${FACTORY.file}?ref=main`,
      answer: () => ({ body: { content: Buffer.from(options.pin ?? PIN).toString('base64') } }),
    },
    {
      method: 'GET',
      path: `/repos/${REPO}/commits?sha=main&per_page=100`,
      answer: () => ({ body: ['d', 'c', 'b', 'a'].map((c) => ({ sha: commit(c) })) }),
    },
    {
      method: 'GET',
      path: `/repos/${REPO}/pulls?state=open&head=mrogan:deploy%2Ffactory-local`,
      answer: () => ({ body: options.open ?? [] }),
    },
    {
      method: 'GET',
      path: `/repos/${REPO}/git/ref/heads/main`,
      answer: () => ({ body: { object: { sha: commit('d') } } }),
    },
    { method: 'PATCH', path: `/repos/${REPO}/git/refs/heads/deploy/factory-local`, answer: () => ({ body: {} }) },
    {
      method: 'POST',
      path: '/graphql',
      answer: () => ({ body: { data: { createCommitOnBranch: { commit: { oid: commit('e') } } } } }),
    },
    {
      method: 'POST',
      path: `/repos/${REPO}/pulls`,
      answer: () => ({ status: 201, body: { number: 70, html_url: 'u', node_id: 'n' } }),
    },
    { method: 'POST', path: `/repos/${REPO}/issues/70/labels`, answer: () => ({ body: [] }) },
    { method: 'PATCH', path: `/repos/${REPO}/pulls/69`, answer: () => ({ body: {} }) },
  ];
  return client(routes);
}

/**
 * GHCR, where the factory image was built from c and b and the browser image only from b: c's set is not finished.
 * The pin's digests were built from a.
 */
function ghcr(tags: Record<string, string[]> = {}): Registry {
  const all: Record<string, string[]> = {
    'mrogan/cv-software-factory/factory': [commit('a'), commit('b'), commit('c')],
    'mrogan/cv-software-factory/factory-browser': [commit('a'), commit('b')],
    ...tags,
  };
  return {
    tags: async (image: string) => all[image] ?? [],
    digest: async (image: string) => digest(image.endsWith('browser') ? '8' : '7'),
    revision: async (_image: string, ref: string) => (ref === digest('1') ? commit('a') : undefined),
  } as unknown as Registry;
}

describe('the deploy watch', () => {
  it('proposes the newest commit every image was built from, opening a labelled pull request', async () => {
    const { github, sent } = world();
    await deployWatch({ github, registry: ghcr(), actions: new LiveActions(github), log: quiet }, FACTORY)();
    const writes = calls(sent).filter((s) => s.method !== 'GET');
    expect(writes.map((s) => `${s.method} ${s.path}`)).toEqual([
      `PATCH /repos/${REPO}/git/refs/heads/deploy/factory-local`,
      'POST /graphql',
      `POST /repos/${REPO}/pulls`,
      `POST /repos/${REPO}/issues/70/labels`,
    ]);
    expect(writes[0]?.body).toEqual({ sha: commit('d'), force: true });
    const { input } = (writes[1] as { body: { variables: unknown } }).body.variables as {
      input: {
        expectedHeadOid: string;
        message: { headline: string };
        fileChanges: { additions: { path: string; contents: string }[] };
      };
    };
    expect(input.expectedHeadOid).toBe(commit('d'));
    expect(input.message.headline).toBe(`chore(deploy): run the factory bbbbbbb on the local cluster`);
    const file = Buffer.from(input.fileChanges.additions[0]?.contents ?? '', 'base64').toString();
    expect(pinned(file)).toEqual(
      new Map([
        ['factory', digest('7')],
        ['factory-browser', digest('8')],
      ]),
    );
    expect(writes[2]?.body).toMatchObject({
      head: 'deploy/factory-local',
      base: 'main',
      title: input.message.headline,
    });
    expect(writes[3]?.body).toEqual({ labels: ['deploy: local'] });
  });

  it('moves an open pull request for an older build to the newer one, and leaves one already current', async () => {
    const older = world({
      open: [{ number: 69, title: 'chore(deploy): run the factory aaaaaaa on the local cluster' }],
    });
    await deployWatch(
      { github: older.github, registry: ghcr(), actions: new LiveActions(older.github), log: quiet },
      FACTORY,
    )();
    expect(
      calls(older.sent)
        .filter((s) => s.method !== 'GET')
        .map((s) => `${s.method} ${s.path}`),
    ).toEqual([
      `PATCH /repos/${REPO}/git/refs/heads/deploy/factory-local`,
      'POST /graphql',
      `PATCH /repos/${REPO}/pulls/69`,
    ]);

    const current = world({
      open: [{ number: 69, title: 'chore(deploy): run the factory bbbbbbb on the local cluster' }],
    });
    await deployWatch(
      { github: current.github, registry: ghcr(), actions: new LiveActions(current.github), log: quiet },
      FACTORY,
    )();
    expect(calls(current.sent).filter((s) => s.method !== 'GET')).toEqual([]);
  });

  it('proposes nothing when the pin is the newest full build, or newer than any', async () => {
    const registry = ghcr();
    (registry as { revision: Registry['revision'] }).revision = async () => commit('b');
    const atB = world();
    await deployWatch({ github: atB.github, registry, actions: new LiveActions(atB.github), log: quiet }, FACTORY)();
    (registry as { revision: Registry['revision'] }).revision = async () => commit('d');
    await deployWatch({ github: atB.github, registry, actions: new LiveActions(atB.github), log: quiet }, FACTORY)();
    expect(calls(atB.sent).filter((s) => s.method !== 'GET' || s.path.includes('/pulls'))).toEqual([]);
  });

  it('in a dry run, records the proposal once rather than every minute', async () => {
    const { github, sent } = world();
    const recorded: string[] = [];
    const actions = new DryRunActions({ put: async () => 'f'.repeat(64) } as never, quiet);
    const watch = deployWatch({ github, registry: ghcr(), actions: Object.assign(actions, {}), log: quiet }, FACTORY);
    const original = actions.openPullRequest.bind(actions);
    actions.openPullRequest = async (repo, draft) => {
      recorded.push(draft.title);
      return original(repo, draft);
    };
    await watch();
    await watch();
    expect(recorded).toEqual(['chore(deploy): run the factory bbbbbbb on the local cluster']);
    expect(calls(sent).filter((s) => s.method !== 'GET')).toEqual([]);
  });
});

describe('the release watch', () => {
  it('runs release-please each time main moves, and not again until it does', async () => {
    let head = 'a';
    const { github } = client([
      {
        method: 'GET',
        path: `/repos/${REPO}/git/ref/heads/main`,
        answer: () => ({ body: { object: { sha: commit(head) } } }),
      },
    ]);
    const runs: string[] = [];
    const watch = releaseWatch(github, REPO, quiet, async () => {
      runs.push(head);
      return { releases: [], pullRequests: [] };
    });
    await watch();
    await watch();
    head = 'b';
    await watch();
    expect(runs).toEqual(['a', 'b']);
  });
});
