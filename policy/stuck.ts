/**
 * How long a work item may stay at each stage of the line before the line counts as stuck there. Prometheus's
 * recording rules carry these figures (`line:stage_limit_seconds`, generated with the alerting rules by the factory's
 * `alerts/rules.ts`), so a dashboard and any alert read one definition, and `make check` fails if the generated rules
 * are out of date.
 *
 * A limit is the longest the line's own bounds should let a work item stay, on Claude, and half an hour more: past
 * it, something the line should have done (end a step, hold for Martin, see a release end) has not happened. A step
 * holds its work item for its lease, its agent's deadline and fifteen minutes (a runner that dies is noticed only when
 * the lease runs out), and a step that fails runs once more before the line holds the work item.
 *
 * Two waits pass the limits by design. On the local model a step may take four times as long (`LOCAL_MODEL_PACE`), so
 * a night on Qwen can pass them at Plan and Build. And while the day's or the month's spend cap is reached, the line
 * starts no step, and work items stand where they are: the gateway's cap refusals say why.
 *
 * `null` is no limit: a work item there waits on something that is not the line's to hurry. These figures are a
 * start, and Martin's to change.
 */
import type { QueueStage } from '../apps/factory/src/line/machine.ts';
import { release } from './release.ts';

/** The stages a work item waits at: every one the line has but `ended`. */
export type StuckStage = Exclude<QueueStage, 'ended'>;

export const STUCK: Record<StuckStage, { minutes: number | null }> = {
  // The planner's step: a 15-minute deadline and its lease's fifteen, twice.
  plan: { minutes: 90 },
  // The coder's step: a 30-minute deadline and its lease's fifteen, twice. A return from the gates or a review starts
  // the stage again.
  build: { minutes: 120 },
  // Waits for overlapping work to be verified or closed, which has limits of its own wherever it is.
  waiting: { minutes: null },
  // The app's checks on the pull request, in GitHub's runners.
  gates: { minutes: 60 },
  // The reviewer's step and then the describer's, a 15-minute deadline and fifteen more each, and one of them again.
  review: { minutes: 120 },
  // A canary's steps take minutes, and its analysis ends it: an hour is a release that never ended.
  release: { minutes: 60 },
  // Verify holds for Martin when a sense has not told for `waitHours`; an hour after that, it should have.
  verify: { minutes: (release.verify.waitHours + 1) * 60 },
  // Waits for Martin, whose time is his own.
  held: { minutes: null },
};
