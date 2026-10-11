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
 * The app's deploy pull request also says what it carries: the line's work items whose fixes merged between the
 * pinned commit and the proposed one, each with its ticket, issue and pull request. The line works that out from its
 * events and tells the worker (`describeDeploy`); the worker keeps no store. The watch remembers each target's open
 * proposal (`DeployProposals`), which the line reads to know the range, and keeps the body's Carries section when it
 * moves the pull request to a newer build, until the line says again.
 *
 * Only images their pipeline signed are proposed: every digest must carry the signature of `build.yml` on main of the
 * repository that built it (`signatures.ts`), as admission will require. A build that does not is not proposed, and
 * the watch looks again each pass. The build workflow pushes its images, then signs them, so a build with no signature
 * yet is waited for; one still unsigned after `SIGNING_GRACE_MS`, or one signed by anyone else, is warned of, once.
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
import { pipeline, type Signatures, UnsignedError } from './signatures.ts';

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

/** A deploy pull request, or an image a deploy pins, that is not one: asked of the worker, refused. */
export class DeployRefused extends Error {
  override name = 'DeployRefused';
}

/** The target a repository's branch is the deploy branch of; any other branch is refused. */
export function deployTarget(repo: string, branch: string): DeployTarget {
  const target = DEPLOYS.find((t) => t.repo === repo && t.branch === branch);
  if (!target) throw new DeployRefused(`${branch} is not a deploy branch of ${repo}.`);
  return target;
}

/** An image one of a repository's deploys pins, as GHCR names it; any other is refused. */
export function deployedImage(repo: string, image: string): string {
  if (!DEPLOYS.some((t) => t.repo === repo && t.images.some((i) => i.image === image))) {
    throw new DeployRefused(`${image} is not an image ${repo} deploys.`);
  }
  return image;
}

/** How long after it first sees a build with no signature the watch warns of it: longer than the signing job takes. */
export const SIGNING_GRACE_MS = 30 * 60_000;

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

/** A target's open deploy pull request, as its watch last saw or made it. */
export interface DeployProposal {
  number: number;
  /** The commit it runs, and the one pinned on main now, when the pinned images' labels say. */
  commit: string;
  pinned: string | null;
  digests: { name: string; image: string; digest: string }[];
}

/**
 * The open deploy pull request of each target, by repository and branch, as the watches last saw or made them: what
 * the line reads to say what a deploy carries. It lives as long as the worker; a worker started again knows each one
 * after its watch's first pass.
 */
export class DeployProposals {
  readonly #open = new Map<string, DeployProposal>();

  set(target: DeployTarget, proposal: DeployProposal | undefined): void {
    const key = `${target.repo} ${target.branch}`;
    if (proposal) this.#open.set(key, proposal);
    else this.#open.delete(key);
  }

  get(repo: string, branch: string): DeployProposal | null {
    return this.#open.get(`${repo} ${branch}`) ?? null;
  }
}

/** A work item a deploy carries: its ticket's number and title, its issue, and the pull request that merged its fix. */
export interface Carry {
  workItem: string;
  title: string;
  issue: number | null;
  pullRequest: number;
}

/** Where the Carries section starts and ends in a deploy pull request's body, so it can be found and replaced. */
const CARRIES_START = '<!-- factory: carries -->';
const CARRIES_END = '<!-- factory: /carries -->';

/**
 * A ticket's title as plain text in a table: on one line, without a pipe, and with nothing GitHub would read as
 * markdown, a link, an HTML tag or a mention. The title is the factory's own, but a cell is no place for markup.
 */
const plain = (title: string) =>
  title
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\`*_[\]|~#:]/g, (c) => `\\${c}`)
    // After the escapes, which would break the entities.
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;');

/** The Carries section of a deploy pull request's body: the work items its commits bring, or that they bring none. */
export function carriesSection(carries: readonly Carry[]): string {
  const rows = carries.map(
    (c) => `| ${c.workItem} | ${plain(c.title)} | ${c.issue ? `#${c.issue}` : '–'} | #${c.pullRequest} |`,
  );
  const said = carries.length
    ? `It carries ${carries.length === 1 ? 'one work item' : `${carries.length} work items`} of the line’s, whose fixes merged since the pinned commit:

| Ticket | Title | Issue | Pull request |
|---|---|---|---|
${rows.join('\n')}`
    : 'It carries none of the line’s work items: no fix of the line’s merged since the pinned commit.';
  return `${CARRIES_START}
### Carries

${said}
${CARRIES_END}`;
}

/** The Carries section a body holds, markers and all, if it holds one. */
export function carriesIn(body: string | null | undefined): string | undefined {
  const start = body?.indexOf(CARRIES_START) ?? -1;
  const end = body?.indexOf(CARRIES_END, start) ?? -1;
  if (!body || start === -1 || end === -1) return undefined;
  return body.slice(start, end + CARRIES_END.length);
}

/** A body with its Carries section replaced by `section`, or with it added at the end where it has none. */
export function withCarries(body: string, section: string): string {
  const kept = carriesIn(body);
  return kept ? body.replace(kept, () => section) : `${body.trimEnd()}\n\n${section}`;
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
 * with the start of its digest, since the diff holds them in full; and where Argo CD deploys them from. With the body
 * it had, it keeps that body's Carries section, until the line says what the newer build carries.
 */
export function deployBody(target: DeployTarget, proposal: Proposal, before?: string | null): string {
  const url = `https://github.com/${target.repo}`;
  const short = (sha: string) => sha.slice(0, 7);
  const since = proposal.pinned
    ? `: [the changes since \`${short(proposal.pinned)}\`](${url}/compare/${proposal.pinned}...${proposal.commit})`
    : '';
  const rows = proposal.digests.map((d) => `| \`${d.name}\` | \`${d.digest.slice(0, 'sha256:'.length + 12)}…\` |`);
  const overlay = target.file.split('/').slice(0, 3).join('/');
  const them = proposal.digests.length === 1 ? 'it' : 'them';
  const body = `Runs [\`${short(proposal.commit)}\`](${url}/commit/${proposal.commit}) on the ${target.profile} cluster${since}.

| Image | Digest |
|---|---|
${rows.join('\n')}

Argo CD deploys ${them} from \`${overlay}\` once this merges. A newer build moves this pull request on rather than opening another.`;
  const carries = carriesIn(before);
  return carries ? `${body}\n\n${carries}` : body;
}

interface Dependencies {
  github: GitHub;
  registry: Registry;
  signatures: Pick<Signatures, 'verify'>;
  actions: Actions;
  log: Logger;
  now?: () => number;
  /** Where the watch says which pull request is open for its target, and what it proposes. */
  proposals?: DeployProposals;
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
    body: z.string().nullable().optional(),
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
  const { github, signatures, actions, log, now = Date.now, proposals = new DeployProposals() } = deps;
  const { repo } = target;
  const label = deployLabel(target);
  // What this worker last proposed, and at which head of main: a pass does nothing more until either moves, and a dry
  // run, which changes nothing in GitHub, records each proposal once.
  let proposed: { title: string; head: string } | undefined;
  // When it first saw each digest with no signature, and the digests it has warned of, so each is said once.
  const waiting = new Map<string, number>();
  const warned = new Set<string>();

  /** Whether every image of a build carries its pipeline's signature; when one does not, says so, once. */
  const signed = async (proposal: Proposal): Promise<boolean> => {
    for (const { image, digest } of proposal.digests) {
      try {
        await signatures.verify(image, digest, pipeline(repo));
      } catch (error) {
        if (!(error instanceof UnsignedError)) throw error;
        const about = { repo, commit: proposal.commit, image, digest, reason: error.message };
        if (error.kind === 'unsigned' && !waiting.has(digest)) {
          waiting.set(digest, now());
          log.info(about, 'waiting for a build to be signed before proposing it');
        }
        const late = error.kind === 'refused' || now() - (waiting.get(digest) ?? 0) >= SIGNING_GRACE_MS;
        if (late && !warned.has(digest)) {
          warned.add(digest);
          log.warn(about, 'did not propose a build its pipeline did not sign');
        }
        return false;
      }
    }
    return true;
  };

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
    // Nothing newer than the pin: whatever was proposed has merged.
    if (!proposal) return proposals.set(target, undefined);
    // An unsigned build is not proposed, and the pull request for the one before stays as it is.
    if (!(await signed(proposal))) return;
    const open = (number: number): DeployProposal => ({
      number,
      commit: proposal.commit,
      pinned: proposal.pinned ?? null,
      digests: proposal.digests,
    });
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
      proposals.set(target, undefined);
      return;
    }
    const existing = pulls.find((p) => p.state === 'open');
    if (existing?.title === title) {
      // Opened by an earlier pass that did not get as far as its label.
      if (!existing.labels.some((l) => l.name === label)) await actions.addLabels(repo, existing.number, [label]);
      proposals.set(target, open(existing.number));
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
    if (existing?.title === title) {
      log.info(
        { repo, number: existing.number, commit: proposal.commit },
        'brought the deploy pull request up to date',
      );
    } else if (existing) {
      // Moved, it keeps what the line said it carries, which the newer build carries too, until the line says again.
      const body = deployBody(target, proposal, existing.body);
      await actions.updatePullRequest(repo, existing.number, { title, body });
      proposals.set(target, open(existing.number));
      log.info(
        { repo, number: existing.number, commit: proposal.commit },
        'moved the deploy pull request to a newer build',
      );
    } else {
      const made = await actions.openPullRequest(repo, {
        head: target.branch,
        base: 'main',
        title,
        body: deployBody(target, proposal),
        labels: [label],
      });
      proposals.set(target, open(made.number));
      log.info({ repo, number: made.number, commit: proposal.commit }, 'opened a deploy pull request');
    }
    proposed = { title, head };
  };
}
