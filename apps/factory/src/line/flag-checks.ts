/**
 * Verify by variant's checks of a feature flag with the probes (milestone 7, task 17), as the line records them: what it
 * asks the probes worker (`probes/flag-check.ts`) for a flag at Off, Checks or Preview, and the `flag.checked` it makes
 * of the answer. Pure, so a test drives it with answers; the pass that asks and appends is `flags.ts`'s.
 *
 * - **Off**, the baseline: what the probes saw with the flag off, recorded as it is, for the stages after to compare with.
 * - **Checks**: failed when a check that passed cleanly with the flag off failed twice with it on (the journeys gate's
 *   rule, the `/device` check among them); unsure with no baseline to compare with; passed otherwise.
 * - **Preview**: as Checks, and failed too unless the `/device` check allowed the preview cookie, which a probe asked
 *   for, as kept to its contract. So it passes only with the preview cookie allowed and nothing kept that the run with
 *   the flag off did not keep.
 *
 * The pages are the front page, whatever pages the spec names (`spec.written`'s `pages`).
 */
import type { ArtifactRef, PayloadOf, Screenshot } from '@software-factory/events';
import type { StoredFlagCheck } from '@software-factory/store';
import type { Checked, CheckedPage, FlagCheckRequest, NotClean } from '../probes/flag-check.ts';
import { short } from '../release/recorded.ts';
import type { Draft } from './gates.ts';

/** The pages a flag's check pictures while its improvement's spec names none: the front page. */
export const FRONT_PAGE = ['/'] as const;

/** The most regressions an event names, as `flag.checked` takes them; how many more it says. */
const MOST_REGRESSIONS = 8;
/** The most checks a baseline names as not clean, and things the device kept, as `flag.checked` takes them. */
const MOST_NOT_CLEAN = 200;
const MOST_KEPT = 10;

/** The preview cookie, as the `/device` check lists it when it keeps to its contract (`senses/device.ts`). */
const PREVIEW_COOKIE = 'cookie preview';

/** A check of the flag the pass asks the probes for. */
export interface CheckAsked {
  flag: string;
  workItem: string;
  stage: FlagCheckRequest['stage'];
  /** The revision of the flag set the app must hold: Martin's latest move's, or `none` before his first. */
  revision: string;
  /** The place in the store of Martin's latest move of the flag, or null when he has never moved it. */
  move: string | null;
  /** The revision that move wrote, which a check at Checks or Preview names as the move it judged. */
  moveRevision?: string;
  /** At Off: the version a baseline was last taken of. */
  have?: string;
  /** At Checks and Preview: the latest baseline, or null when none was taken. */
  base: StoredFlagCheck | null;
  pages: readonly string[];
}

/** What the probes are asked, for a check. */
export function requestOf(asked: CheckAsked): FlagCheckRequest {
  const off = asked.base?.check.stage === 'off' ? asked.base.check : undefined;
  return {
    flag: asked.flag,
    stage: asked.stage,
    revision: asked.revision,
    pages: [...asked.pages],
    ...(asked.stage === 'off' && asked.have !== undefined && { have: asked.have }),
    ...(asked.stage !== 'off' && {
      base: off
        ? {
            version: off.version,
            notClean: off.notClean.map(({ message, ...check }) => ({
              ...check,
              ...(message !== undefined && { message }),
            })),
            pictures: off.pages.map((page) => ({ path: page.page, hash: page.off })),
          }
        : null,
    }),
  };
}

const asCheck = ({ sense, check, route, failed, message }: NotClean) => ({
  sense,
  check: check.slice(0, 120),
  route,
  failed,
  ...(message?.trim() && { message: message.trim().slice(0, 300) }),
});

/** Each screenshot once, in the order given: an event's artifacts. */
function artifactsOf(shots: readonly (Screenshot | undefined)[]): ArtifactRef[] {
  const seen = new Set<string>();
  return shots.filter((shot): shot is Screenshot => {
    if (!shot || seen.has(shot.hash)) return false;
    seen.add(shot.hash);
    return true;
  });
}

const stageName = { off: 'Off', checks: 'Checks', preview: 'Preview' } as const;

/** The `flag.checked` an answer makes. */
export function checkedDraft(asked: CheckAsked, answer: Checked): Draft {
  const { flag } = asked;
  const { version, revision, journeys } = answer;
  if (asked.stage === 'off') {
    const pages = answer.pages.flatMap((p) => (p.off ? [{ page: p.path, route: p.route, off: p.off }] : []));
    return {
      type: 'flag.checked',
      actor: 'factory',
      summary: `${flag} with the flag off, on ${short(version)}: ${journeys.passed} of ${journeys.ran} checks passed`,
      payload: {
        stage: 'off',
        flag,
        version,
        revision,
        journeys,
        notClean: answer.notClean.slice(0, MOST_NOT_CLEAN).map(asCheck),
        pages: pages.map(({ off, ...page }) => ({ ...page, off: off.hash })),
      } satisfies PayloadOf<'flag.checked'>,
      artifacts: artifactsOf(pages.map((p) => p.off)),
    };
  }
  const off = asked.base?.check.stage === 'off' ? asked.base.check : undefined;
  const regressions = answer.regressions ?? [];
  // A baseline that names fewer checks than did not pass cleanly (more than an event keeps) cannot say which passed.
  const whole = off !== undefined && off.notClean.length === off.journeys.ran - off.journeys.passed;
  const { outcome, reason } = judged(asked.stage, off !== undefined, whole, regressions, answer.device);
  const common = {
    flag,
    version,
    revision,
    // The move judged: a check of no move would never count, and the pass asks at Checks and Preview only after one.
    moveRevision: asked.moveRevision ?? 'none',
    against: off?.version ?? null,
    outcome,
    journeys: { base: off?.journeys ?? null, change: journeys },
    regressions: regressions.slice(0, MOST_REGRESSIONS).map(asCheck),
    ...(regressions.length > MOST_REGRESSIONS && { more: regressions.length - MOST_REGRESSIONS }),
    ...(reason && { reason: reason.slice(0, 300) }),
  };
  const summary = `${flag} at ${stageName[asked.stage]}: ${{ passed: 'passed', failed: 'failed', unsure: 'could not tell' }[outcome]}`;
  if (asked.stage === 'checks') {
    const pages = answer.pages.filter((p): p is CheckedPage & { on: Screenshot } => p.on !== undefined);
    return {
      type: 'flag.checked',
      actor: 'factory',
      summary,
      payload: {
        stage: 'checks',
        ...common,
        pages: pages.map((p) => ({
          page: p.path,
          route: p.route,
          ...(p.off && { off: p.off.hash }),
          on: p.on.hash,
          ...(p.changed !== undefined && { changed: p.changed }),
          ...(p.diff && { diff: p.diff.hash }),
        })),
      } satisfies PayloadOf<'flag.checked'>,
      artifacts: artifactsOf(pages.flatMap((p) => [p.off, p.on, p.diff])),
    };
  }
  const cut = (things: string[]) => things.slice(0, MOST_KEPT).map((thing) => thing.slice(0, 200));
  return {
    type: 'flag.checked',
    actor: 'factory',
    summary,
    payload: {
      stage: 'preview',
      ...common,
      device: { allowed: cut(answer.device.allowed), kept: cut(answer.device.kept) },
    } satisfies PayloadOf<'flag.checked'>,
  };
}

/** How a check at Checks or Preview came out, and why, in words, when it did not pass. */
function judged(
  stage: 'checks' | 'preview',
  based: boolean,
  whole: boolean,
  regressions: readonly NotClean[],
  device: Checked['device'],
): { outcome: 'passed' | 'failed' | 'unsure'; reason?: string } {
  const why: string[] = [];
  if (based && !whole && regressions.length) {
    return {
      outcome: 'unsure',
      reason: 'The run with the flag off names fewer of its failing checks than failed, so a regression cannot be told',
    };
  }
  if (regressions.length) {
    const [first] = regressions;
    const n = regressions.length;
    why.push(
      `${n === 1 ? 'A check' : `${n} checks`} that passed with the flag off failed twice with it on: ${first?.check}${first?.message ? `, ${first.message}` : ''}`,
    );
  }
  if (stage === 'preview' && !device.allowed.includes(PREVIEW_COOKIE)) {
    const broken = device.kept.find((thing) => thing.startsWith(`${PREVIEW_COOKIE} (`));
    why.push(
      broken
        ? `The preview cookie breaks its contract: ${broken.slice(PREVIEW_COOKIE.length + 2, -1)}`
        : 'The app kept no preview cookie when a probe asked to preview the flag',
    );
  }
  if (why.length) return { outcome: 'failed', reason: why.join('. ') };
  if (!based) {
    return {
      outcome: 'unsure',
      reason: 'No run with the flag off was taken before it went on, so nothing it changed can be told apart',
    };
  }
  return { outcome: 'passed' };
}
