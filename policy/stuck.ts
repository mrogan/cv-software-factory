/**
 * How long a work item may stay at each stage of the line before the line counts as stuck there. Prometheus's
 * recording rules carry these figures (`line:stage_limit_seconds`, generated with the alerting rules by the factory's
 * `alerts/rules.ts`), so a dashboard and any alert read one definition, and `make check` fails if the generated rules
 * are out of date.
 *
 * A limit is the longest the line's own bounds should let a work item stay, on Claude, with some to spare: past it,
 * something the line should have done (end a step, hold for Martin, see a release end) has not happened. A step's
 * time is its agent's deadline and up to ten minutes to prepare, and a step that fails runs once more before the line
 * holds the work item. On the local model a step may take four times as long (`LOCAL_MODEL_PACE`), so a night on Qwen
 * can pass the limits at Plan and Build without anything being wrong.
 *
 * `null` is no limit: a work item there waits on something that is not the line's to hurry. These figures are a
 * start, and Martin's to change.
 */
import { release } from './release.ts';

/** The stages a work item waits at, as the line's metrics name them. */
export type StuckStage = 'plan' | 'build' | 'waiting' | 'gates' | 'review' | 'release' | 'verify' | 'held';

export const STUCK: Record<StuckStage, { minutes: number | null }> = {
  // The planner's step: a 15-minute deadline and its preparing, twice.
  plan: { minutes: 60 },
  // The coder's step: a 30-minute deadline and its preparing, twice. A return from the gates or a review starts the
  // stage again.
  build: { minutes: 90 },
  // Waits for overlapping work to be verified or closed, which has limits of its own wherever it is.
  waiting: { minutes: null },
  // The app's checks on the pull request, in GitHub's runners.
  gates: { minutes: 60 },
  // The reviewer's step and then the describer's, 15 minutes each with their preparing, and one of them again.
  review: { minutes: 90 },
  // A canary's steps take minutes, and its analysis ends it: an hour is a release that never ended.
  release: { minutes: 60 },
  // Verify holds for Martin when a sense has not told for `waitHours`; an hour after that, it should have.
  verify: { minutes: (release.verify.waitHours + 1) * 60 },
  // Waits for Martin, whose time is his own.
  held: { minutes: null },
};
