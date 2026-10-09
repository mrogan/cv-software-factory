/**
 * Deploy pull requests, opened by the App (ADR 0005). Argo CD deploys only what is in git, so a new image reaches a
 * cluster through a pull request that pins its digest in a profile's overlay. The build workflow builds and pushes
 * images and opens nothing; this watch sees each new image and proposes it.
 *
 * Each target is one pin file and the images it pins, which are built together from one commit. A target has at
 * most one open pull request, on its own branch, always for the newest commit on main that every one of its images
 * was built from. When that commit is newer than the one pinned on main, the new digests are committed on main's head
 * (signed, through the API), the branch is moved to that commit, and the pull request is opened, or retitled if it
 * was for an older build.
 *
 * The branch is never at main's head itself, even for a moment: GitHub closes a pull request whose branch has nothing
 * to merge, and would close the one for the older build, as the App. So the commit is made on a scratch branch of
 * the factory's (`factory/` and the deploy branch's name), started at main's head, and the deploy branch is moved to
 * it in one forced update. The commit goes through `createCommitOnBranch` like every other, so GitHub signs it.
 *
 * The deploy branch is this watch's alone: the watch that keeps the App's pull requests current leaves it be
 * (`current.ts`). When main moves on and the build is still the newest (a merge that built no image), the branch is
 * behind main, and the ruleset will not merge it; so the pin commit is made again, the same way, on main's new head.
 * Not once Martin has approved, as for the App's other pull requests: a push would make his approval stale.
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
      { name: 'factory-runner', image: 'mrogan/cv-software-factory/factory-runner' },
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

/** Where a target's new pins are committed before its deploy branch moves to them. */
export const scratchBranch = (target: DeployTarget) => `factory/${target.branch}`;

/** The label that marks a deploy pull request apart from the release pull request and Martin's own. */
export const deployLabel = (target: DeployTarget) => `deploy: ${target.profile}`;

export const deployTitle = (target: DeployTarget, commit: string) =>
  `chore(deploy): run ${target.what ? `${target.what} ` : ''}${commit.slice(0, 7)} on the ${target.profile} cluster`;

/** What a deploy proposes: the commit, and each image's digest built from it. */
export interface Proposal {
  commit: string;
  /** The commit the pinned images were built from, when their labels say. */
  pinned?: string | undefined;
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

/**
 * What a deploy pull request says: the commit it runs, linked, with the changes since the one pinned now; each image
 * with the start of its digest, since the diff holds them in full; and where Argo CD deploys them from.
 */
export function deployBody(target: DeployTarget, proposal: Proposal): string {
  const url = `https://github.com/${target.repo}`;
  const short = (sha: string) => sha.slice(0, 7);
  const since = proposal.pinned
    ? `: [the changes since \`${short(proposal.pinned)}\`](${url}/compare/${proposal.pinned}...${proposal.commit})`
    : '';
  const rows = proposal.digests.map((d) => `| \`${d.name}\` | \`${d.digest.slice(0, 'sha256:'.length + 12)}…\` |`);
  const overlay = target.file.split('/').slice(0, 3).join('/');
  const them = proposal.digests.length === 1 ? 'it' : 'them';
  return `Runs [\`${short(proposal.commit)}\`](${url}/commit/${proposal.commit}) on the ${target.profile} cluster${since}.

| Image | Digest |
|---|---|
${rows.join('\n')}

Argo CD deploys ${them} from \`${overlay}\` once this merges. A newer build moves this pull request on rather than opening another.`;
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
    head: z.object({ sha: z.string() }),
  }),
);
const COMPARISON = z.object({ behind_by: z.number().int().nonnegative() });
const REVIEWS = z.array(z.object({ state: z.string() }));

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
  return { commit, pinned: pinnedCommit, digests };
}

/**
 * Watches one target, and opens or moves its deploy pull request when main has a newer build than the pin, or makes
 * its commit again on main's head when main has moved on with no newer build.
 */
export function deployWatch(deps: Dependencies, target: DeployTarget): Watch {
  const { github, actions, log } = deps;
  const { repo } = target;
  const label = deployLabel(target);
  // What this worker last proposed, and at which head of main: a pass does nothing more until either moves, and a dry
  // run, which changes nothing in GitHub, records each proposal once.
  let proposed: { title: string; head: string } | undefined;

  /** Whether a deploy pull request's branch is behind main's head and nobody has approved it, so it is the watch's to move. */
  const behind = async (number: number, sha: string, head: string): Promise<boolean> => {
    const { body: comparison } = await github.poll(repo, `/repos/${repo}/compare/${head}...${sha}`, COMPARISON);
    if (comparison.behind_by === 0) return false;
    const { body: reviews } = await github.poll(repo, `/repos/${repo}/pulls/${number}/reviews?per_page=100`, REVIEWS);
    if (!reviews.some((r) => r.state === 'APPROVED')) return true;
    log.info({ repo, number, behind: comparison.behind_by }, 'left an approved deploy pull request behind main');
    return false;
  };

  return async () => {
    // One head of main for the whole pass: the pin file, the commits and the branch all come from it.
    const { body: main } = await github.poll(repo, `/repos/${repo}/git/ref/heads/main`, HEAD);
    const head = main.object.sha;
    const { body: file } = await github.poll(repo, `/repos/${repo}/contents/${target.file}?ref=${head}`, CONTENT);
    const pinFile = Buffer.from(file.content, 'base64').toString('utf-8');
    const proposal = await newerBuild(deps, target, pinFile, head);
    if (!proposal) return;
    const title = deployTitle(target, proposal.commit);
    if (proposed?.title === title && proposed.head === head) return;

    const [owner] = repo.split('/');
    const { body: pulls } = await github.poll(
      repo,
      `/repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=20&head=${owner}:${encodeURIComponent(target.branch)}`,
      PULLS,
    );
    if (pulls.some((p) => p.state === 'closed' && !p.merged_at && p.title === title)) {
      if (proposed?.title !== title) {
        log.info(
          { repo, commit: proposal.commit },
          'this build’s deploy pull request was closed; waiting for the next',
        );
      }
      proposed = { title, head };
      return;
    }
    const existing = pulls.find((p) => p.state === 'open');
    if (existing?.title === title) {
      // Opened by an earlier pass that did not get as far as its label.
      if (!existing.labels.some((l) => l.name === label)) await actions.addLabels(repo, existing.number, [label]);
      if (!(await behind(existing.number, existing.head.sha, head))) {
        proposed = { title, head };
        return;
      }
    } else if (!existing && proposed?.title === title) {
      // A dry run's pull request, which GitHub has never heard of: recorded once, and not again as main moves.
      proposed = { title, head };
      return;
    }

    // Committed off to the side, so the deploy branch goes from its older commit straight to this one (see above).
    const scratch = scratchBranch(target);
    await actions.setBranch(repo, scratch, head, { force: true });
    const pins = await actions.commit(repo, {
      branch: scratch,
      expectedHead: head,
      message: title,
      changes: {
        additions: [{ path: target.file, contents: new TextEncoder().encode(repin(pinFile, proposal)) }],
        deletions: [],
      },
    });
    await actions.setBranch(repo, target.branch, pins, { force: true });
    await actions.deleteBranch(repo, scratch);
    const body = deployBody(target, proposal);
    if (existing?.title === title) {
      log.info(
        { repo, number: existing.number, commit: proposal.commit },
        'brought the deploy pull request up to date',
      );
    } else if (existing) {
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
    proposed = { title, head };
  };
}
