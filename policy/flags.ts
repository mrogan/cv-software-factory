/**
 * The stages a feature flag goes out in, as the shapes flagd reads (milestone 7, task 16). Martin stages each flag from
 * the console; the admin service writes his stages into the one FeatureFlag, `flags` in `flagd`, rendered here and
 * nowhere else, so it writes typed stages and never flagd's own JSON. The `flagd-flag-stages` admission policy
 * (deploy/base/admission/flagd/flag-stages.yaml) admits the admin service's change only when every flag in it is one of
 * these shapes, and `apps/factory/test/flag-fences.test.ts` holds the cluster's answers to what this renders, so the two
 * cannot drift apart.
 *
 * Each stage keeps the ones before it, and is a fixed shape of flagd's targeting over the app's evaluation context
 * (docs/COMPONENTS/FEATURE-FLAGS.md, "The evaluation context"):
 *
 *   off        nobody: the flag is there, its default off, with no targeting. Off is a change, never a deletion.
 *   checks     the factory's own checks' requests, `marked`
 *   preview    also a request whose `preview` names the flag
 *   share      also a share of the signed requests (`signed`), by flagd's `fractional` rule over the signed id
 *              (`targetingKey`), two variants weighted by the share and the rest
 *   everyone   everyone: the default on
 *
 * The share is the only parameter. A flag `flags` does not name is off, by its default in the app.
 *
 * Beside the features, the reserved string flag `flag-set-revision` names the flag set: the admin service sets a new
 * one with every write, and the app reports the one it holds to a marked request (FEATURE-FLAGS.md, "The revision").
 *
 * Human-owned: see `README.md`.
 */

/** The stages, in the order a flag widens through them. */
export const STAGES = ['off', 'checks', 'preview', 'share', 'everyone'] as const;
export type StageName = (typeof STAGES)[number];

/** The shares of the signed requests the share stage may take, in percent. */
export const SHARES = [10, 25, 50] as const;
export type Share = (typeof SHARES)[number];

/** A flag's stage: the share stage with its share, any other alone. */
export type Stage = { stage: Exclude<StageName, 'share'> } | { stage: 'share'; share: Share };

/**
 * A feature flag's name, as the app names them: lower-case letters and digits, in words joined by hyphens. The app
 * never evaluates a flag named otherwise.
 */
export const FLAG_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The reserved flag that names the flag set. Never a feature, and never staged. */
export const REVISION_FLAG = 'flag-set-revision';

/** The words the app's `x-flags-revision` keeps for no revision: a revision is never one of them. */
export const RESERVED_REVISIONS = ['none', 'stale', 'invalid'] as const;

/** A revision the app reports as it is: visible ASCII, `!` to `~`, of 1 to 128 characters. */
export const REVISION = /^[!-~]{1,128}$/;

/** One flag as flagd reads it. */
export interface FlagdFlag {
  state: 'ENABLED';
  variants: Record<string, boolean | string>;
  defaultVariant: string;
  targeting?: Record<string, unknown>;
}

/** What the admin service writes to `flags`: its whole `spec`. */
export interface FlagsSpec {
  flagSpec: { flags: Record<string, FlagdFlag> };
}

export const isFlagName = (name: string): boolean => FLAG_NAME.test(name) && name !== REVISION_FLAG;

export const isRevision = (revision: string): boolean =>
  REVISION.test(revision) && !(RESERVED_REVISIONS as readonly string[]).includes(revision);

const VARIANTS = { on: true, off: false } as const;
const marked = [{ '==': [{ var: 'marked' }, true] }, 'on'];
const previewed = (name: string) => [{ in: [name, { var: 'preview' }] }, 'on'];
const shared = (share: Share) => [
  { '==': [{ var: 'signed' }, true] },
  {
    fractional: [
      ['on', share],
      ['off', 100 - share],
    ],
  },
];

/** One feature flag at its stage. Throws for a name that is not a flag's, or a share that is not one of `SHARES`. */
export function flag(name: string, stage: Stage): FlagdFlag {
  if (!isFlagName(name)) throw new Error(`Not a feature flag's name: ${JSON.stringify(name)}`);
  const off = { state: 'ENABLED', variants: { ...VARIANTS }, defaultVariant: 'off' } as const;
  switch (stage.stage) {
    case 'off':
      return off;
    case 'checks':
      return { ...off, targeting: { if: [...marked, 'off'] } };
    case 'preview':
      return { ...off, targeting: { if: [...marked, ...previewed(name), 'off'] } };
    case 'share':
      if (!(SHARES as readonly number[]).includes(stage.share)) {
        throw new Error(`Not a share of the share stage: ${JSON.stringify(stage.share)}`);
      }
      return { ...off, targeting: { if: [...marked, ...previewed(name), ...shared(stage.share), 'off'] } };
    case 'everyone':
      return { ...off, defaultVariant: 'on' };
    default:
      throw new Error(`Not a stage: ${JSON.stringify((stage as { stage: unknown }).stage)}`);
  }
}

/** The revision flag, naming the flag set. Throws for a revision the app would not report as it is. */
export function revisionFlag(revision: string): FlagdFlag {
  if (!isRevision(revision)) throw new Error(`Not a flag set's revision: ${JSON.stringify(revision)}`);
  return { state: 'ENABLED', variants: { revision }, defaultVariant: 'revision' };
}

/**
 * The whole spec of `flags`: every flag at its stage, by name, and the revision. The admin service renders it from
 * every flag's latest stage and a new revision, and writes it whole. Throws as `flag` and `revisionFlag` do.
 */
export function flagsSpec(stages: Readonly<Record<string, Stage>>, revision: string): FlagsSpec {
  const flags: Record<string, FlagdFlag> = {};
  for (const name of Object.keys(stages).sort()) flags[name] = flag(name, stages[name] as Stage);
  flags[REVISION_FLAG] = revisionFlag(revision);
  return { flagSpec: { flags } };
}
