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
 * 1f14f44 on the local cluster`. A proposal Martin closed without merging is not made again; the next build is.
 *
 * Everything in one pass is read at one commit of main, the head it starts from, so a pin that moves on main while
 * it runs is not reverted.
 */
import type { Logger } from 'pino';
import { parse } from 'yaml';
import { z } from 'zod';
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

const PIN_FILE = z
  .object({
    images: z
      .array(z.object({ name: z.string(), digest: z.string().optional() }))
      .nullable()
      .optional(),
  })
  .nullable();

/** A pin file that does not say what the factory expects of it. */
export class PinFileError extends Error {
  override name = 'PinFileError';
}

/** The digests a pin file holds, by kustomize name. */
export function pinned(file: string): Map<string, string> {
  const parsed = PIN_FILE.safeParse(parse(file));
  if (!parsed.success) throw new PinFileError('The pin file is not a kustomization with images.');
  return new Map((parsed.data?.images ?? []).flatMap((i) => (i.digest ? [[i.name, i.digest] as const] : [])));
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
    if (!old) throw new PinFileError(`The pin file has no digest for ${name}.`);
    // A function, so nothing in the digest is read as a replacement pattern.
    next = next.replace(old, () => digest);
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

const SHA = z.string().regex(/^[0-9a-f]{40}$/);
const HEAD = z.object({ object: z.object({ sha: SHA }) });
const COMMITS = z.array(z.object({ sha: z.string() }));
const CONTENT = z.object({ content: z.string() });
const PULLS = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    state: z.string(),
    merged_at: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
  }),
);

/**
 * The newest commit on main, up to `head`, that every image the pin file pins was built from, with each image's
 * digest; or undefined when there is none newer than the pinned one. An image of the target the file does not pin
 * yet is left out: the change that brings it in pins it.
 */
export async function newerBuild(
  { github, registry }: Pick<Dependencies, 'github' | 'registry'>,
  target: DeployTarget,
  pinFile: string,
  head: string,
): Promise<Proposal | undefined> {
  const pins = pinned(pinFile);
  const images = target.images.filter((i) => pins.has(i.name));
  if (!images.length) return undefined;
  const { body: commits } = await github.poll(
    target.repo,
    `/repos/${target.repo}/commits?sha=${head}&per_page=100`,
    COMMITS,
  );
  const tags = await Promise.all(images.map(async (i) => new Set(await registry.tags(i.image))));
  const newest = commits.findIndex((c) => tags.every((t) => t.has(c.sha)));
  if (newest === -1) return undefined;
  const commit = commits[newest]?.sha as string;

  const [first] = images;
  const pinnedDigest = first && pins.get(first.name);
  const pinnedCommit = first && pinnedDigest ? await registry.revision(first.image, pinnedDigest) : undefined;
  if (pinnedCommit) {
    const at = commits.findIndex((c) => c.sha === pinnedCommit);
    // The pin is this build, or a newer one than any this target has a full set of images for.
    if (at !== -1 && at <= newest) return undefined;
  }
  const digests = await Promise.all(
    images.map(async (i) => ({ ...i, digest: await registry.digest(i.image, commit) })),
  );
  return { commit, digests };
}

/** Watches one target, and opens or moves its deploy pull request when main has a newer build than the pin. */
export function deployWatch(deps: Dependencies, target: DeployTarget): Watch {
  const { github, actions, log } = deps;
  const { repo } = target;
  const label = deployLabel(target);
  // What this worker last proposed, so a dry run, which changes nothing in GitHub, records each proposal once.
  let proposed: string | undefined;
  return async () => {
    // One head of main for the whole pass: the pin file, the commits and the branch all come from it.
    const { body: main } = await github.poll(repo, `/repos/${repo}/git/ref/heads/main`, HEAD);
    const head = main.object.sha;
    const { body: file } = await github.poll(repo, `/repos/${repo}/contents/${target.file}?ref=${head}`, CONTENT);
    const pinFile = Buffer.from(file.content, 'base64').toString('utf-8');
    const proposal = await newerBuild(deps, target, pinFile, head);
    if (!proposal) return;
    const title = deployTitle(target, proposal.commit);
    if (proposed === title) return;

    const [owner] = repo.split('/');
    const { body: pulls } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=20&head=${owner}:${encodeURIComponent(target.branch)}`,
      PULLS,
    );
    if (pulls.some((p) => p.state === 'closed' && !p.merged_at && p.title === title)) {
      log.info({ repo, commit: proposal.commit }, 'this build’s deploy pull request was closed; waiting for the next');
      proposed = title;
      return;
    }
    const existing = pulls.find((p) => p.state === 'open');
    if (existing?.title === title) {
      // Opened by an earlier pass that did not get as far as its label.
      if (!existing.labels.some((l) => l.name === label)) await actions.addLabels(repo, existing.number, [label]);
      proposed = title;
      return;
    }

    await actions.setBranch(repo, target.branch, head, { force: true });
    await actions.commit(repo, {
      branch: target.branch,
      expectedHead: head,
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
        labels: [label],
      });
      log.info({ repo, number: made.number, commit: proposal.commit }, 'opened a deploy pull request');
    }
    proposed = title;
  };
}
