/**
 * Deploy pull requests, opened by the App (ADR 0005). Argo CD deploys only what is in git, so a new image reaches a
 * cluster through a pull request that pins its digest in a profile's overlay. The build workflow builds and pushes
 * images and opens nothing; this watch sees each new image and proposes it.
 *
 * Each target is one pin file and the images it pins, which are built together from one commit. A target has at
 * most one open pull request, on its own branch, always for the newest commit on main that every one of its images
 * was built from. When that commit is newer than the one pinned on main, the branch is moved to main's head, the new
 * digests are committed to it (signed, through the API), and the pull request is opened, or retitled if it was for
 * an older build.
 *
 * Its title names the commit, as the build workflow's `changes` job reads it back: `chore(deploy): run console
 * 1f14f44 on the local cluster`.
 */
import type { Logger } from 'pino';
import { parse } from 'yaml';
import type { Actions } from './actions.ts';
import type { GitHub } from './client.ts';
import type { Watch } from './poller.ts';
import type { Registry } from './registry.ts';

export interface DeployTarget {
  repo: string;
  /** What the title says it runs: `console`, `the factory`, or nothing for the app's one image. */
  what: string;
  profile: 'local';
  branch: string;
  /** The kustomization that pins the images. */
  file: string;
  /** Each image as kustomize names it, and where it is in GHCR. */
  images: { name: string; image: string }[];
}

export const DEPLOYS: DeployTarget[] = [
  {
    repo: 'mrogan/cv-software-factory',
    what: 'console',
    profile: 'local',
    branch: 'deploy/console-local',
    file: 'deploy/overlays/local/console-image/kustomization.yaml',
    images: [{ name: 'console', image: 'mrogan/cv-software-factory/console' }],
  },
  {
    repo: 'mrogan/cv-software-factory',
    what: 'the factory',
    profile: 'local',
    branch: 'deploy/factory-local',
    file: 'deploy/overlays/local/factory-image/kustomization.yaml',
    images: [
      { name: 'factory', image: 'mrogan/cv-software-factory/factory' },
      { name: 'factory-browser', image: 'mrogan/cv-software-factory/factory-browser' },
    ],
  },
  {
    repo: 'mrogan/cv-worlds-worst-website',
    what: '',
    profile: 'local',
    branch: 'deploy/local',
    file: 'deploy/overlays/local/image/kustomization.yaml',
    images: [{ name: 'website', image: 'mrogan/cv-worlds-worst-website' }],
  },
];

/** The label that marks a deploy pull request apart from the release pull request and Martin's own. */
export const deployLabel = (target: DeployTarget) => `deploy: ${target.profile}`;

export const deployTitle = (target: DeployTarget, commit: string) =>
  `chore(deploy): run ${target.what ? `${target.what} ` : ''}${commit.slice(0, 7)} on the ${target.profile} cluster`;

/** What a deploy proposes: the commit, and each image's digest built from it. */
export interface Proposal {
  commit: string;
  digests: { name: string; image: string; digest: string }[];
}

interface PinnedImage {
  name: string;
  newName?: string;
  digest?: string;
}

/** The digests a pin file holds, by kustomize name. */
export function pinned(file: string): Map<string, string> {
  const images = ((parse(file) as { images?: PinnedImage[] } | null)?.images ?? []).filter((i) => i.digest);
  return new Map(images.map((i) => [i.name, i.digest as string]));
}

/**
 * The pin file with each image moved to its new digest. Only the digests change, as text: the file keeps the layout
 * `kustomize edit` gave it, so the diff is the digests and nothing else.
 */
export function repin(file: string, proposal: Proposal): string {
  const current = pinned(file);
  let next = file;
  for (const { name, digest } of proposal.digests) {
    const old = current.get(name);
    if (!old) throw new Error(`The pin file has no digest for ${name}`);
    next = next.replace(old, digest);
  }
  return next;
}

export function deployBody(target: DeployTarget, proposal: Proposal): string {
  const images = proposal.digests.map((d) => `\`${d.name}\` (ghcr.io/${d.image}@${d.digest})`);
  const list = images.length === 1 ? images[0] : `${images.slice(0, -1).join(', ')} and ${images.at(-1)}`;
  const overlay = target.file.split('/').slice(0, 3).join('/');
  return `Pins ${list}, built from ${proposal.commit}, in \`${overlay}\`. Argo CD deploys ${images.length === 1 ? 'it' : 'them'} once this is merged.

Opened by the factory's GitHub worker. A newer build replaces this pull request's change.`;
}

interface Dependencies {
  github: GitHub;
  registry: Registry;
  actions: Actions;
  log: Logger;
}

/**
 * The newest commit on main that every image of the target was built from, with each image's digest; or undefined
 * when there is none newer than the pinned one.
 */
export async function newerBuild(
  { github, registry }: Pick<Dependencies, 'github' | 'registry'>,
  target: DeployTarget,
  pinFile: string,
): Promise<Proposal | undefined> {
  const { body: commits } = await github.poll<{ sha: string }[]>(
    target.repo,
    `/repos/${target.repo}/commits?sha=main&per_page=100`,
  );
  const tags = await Promise.all(target.images.map(async (i) => new Set(await registry.tags(i.image))));
  const newest = commits.findIndex((c) => tags.every((t) => t.has(c.sha)));
  if (newest === -1) return undefined;
  const commit = commits[newest]?.sha as string;

  const [first] = target.images;
  const pinnedDigest = first && pinned(pinFile).get(first.name);
  const pinnedCommit = pinnedDigest ? await registry.revision(first.image, pinnedDigest) : undefined;
  if (pinnedCommit) {
    const at = commits.findIndex((c) => c.sha === pinnedCommit);
    // The pin is this build, or a newer one than any this target has a full set of images for.
    if (at !== -1 && at <= newest) return undefined;
  }
  const digests = await Promise.all(
    target.images.map(async (i) => ({ ...i, digest: await registry.digest(i.image, commit) })),
  );
  return { commit, digests };
}

/** Watches one target, and opens or moves its deploy pull request when main has a newer build than the pin. */
export function deployWatch(deps: Dependencies, target: DeployTarget): Watch {
  const { github, actions, log } = deps;
  const { repo } = target;
  // What this worker last proposed, so a dry run, which changes nothing in GitHub, records each proposal once.
  let proposed: string | undefined;
  return async () => {
    const { body: file } = await github.poll<{ content: string }>(
      repo,
      `/repos/${repo}/contents/${target.file}?ref=main`,
    );
    const pinFile = Buffer.from(file.content, 'base64').toString('utf-8');
    const proposal = await newerBuild(deps, target, pinFile);
    if (!proposal) return;
    const title = deployTitle(target, proposal.commit);
    if (proposed === title) return;

    const [owner] = repo.split('/');
    const { body: open } = await github.poll<{ number: number; title: string }[]>(
      repo,
      `/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(target.branch)}`,
    );
    const existing = open[0];
    if (existing?.title === title) {
      proposed = title;
      return;
    }

    const { body: main } = await github.poll<{ object: { sha: string } }>(repo, `/repos/${repo}/git/ref/heads/main`);
    await actions.setBranch(repo, target.branch, main.object.sha, { force: true });
    await actions.commit(repo, {
      branch: target.branch,
      expectedHead: main.object.sha,
      message: title,
      changes: {
        additions: [{ path: target.file, contents: new TextEncoder().encode(repin(pinFile, proposal)) }],
        deletions: [],
      },
    });
    const body = deployBody(target, proposal);
    if (existing) {
      await actions.updatePullRequest(repo, existing.number, { title, body });
      log.info(
        { repo, number: existing.number, commit: proposal.commit },
        'moved the deploy pull request to a newer build',
      );
    } else {
      const made = await actions.openPullRequest(repo, {
        head: target.branch,
        base: 'main',
        title,
        body,
        labels: [deployLabel(target)],
      });
      log.info({ repo, number: made.number, commit: proposal.commit }, 'opened a deploy pull request');
    }
    proposed = title;
  };
}
