/**
 * Martin's controls of the app's release, from the console's Canary panel: the admin service reads the app's Rollout
 * and patches it, as its own service account, whose Role names that Rollout alone
 * (deploy/base/analysis/admin-controls-release.yaml), and whose every patch an admission policy holds to the fields
 * below (deploy/base/admission/website/rollout-controls.yaml). Each is the patch `kubectl argo rollouts` makes:
 *
 * - **Promote**, to the next step's weight: the status's step moved on to the next step that sets a weight short of
 *   100%, and its pauses cleared, wherever the canary is in the step it is at (setting its weight, pausing, or being
 *   analysed): the analysis of a step it leaves is stopped, as Argo Rollouts stops one for any step left behind.
 * - **Promote fully**: `status.promoteFull`, which sends the canary all of the traffic at once, skipping what is left.
 * - **Pause** and **Resume**: `spec.paused`. A paused canary keeps its weight until Martin resumes, promotes or aborts
 *   it; resuming gives it back to its own analysis, as it was, and promotes nothing. A promotion resumes a paused
 *   canary too, as `kubectl argo rollouts promote` does.
 * - **Abort**: `status.abort`. The version before takes all of the traffic at once. Nothing failed, so it is no
 *   signal; the line records `release.aborted` with `by: martin`, from this control's event.
 * - **Retry**: `status.abort` cleared, for a release that was stopped (by Martin, by stopping the line, or by an
 *   analysis error), which starts again from its first step. Not while the line is stopped, which starts no canary,
 *   and never after a rollback, which is the analysis's: the fix goes out with the next release that carries it.
 *
 * There is no rollback: that stays the analysis's alone.
 *
 * Each control names the release the panel showed Martin, and is refused if another is in flight now. The first patch
 * is conditional on the Rollout being as it was read (its `resourceVersion`), so a release that moved on in between is
 * read again, and the control decided again, rather than applied to what Martin did not see.
 *
 * The control's event, `release.controlled`, is appended in a transaction that commits only once the patch is made: a
 * patch that fails leaves no event. If the commit fails after the patch, the event is appended again on its own, and
 * if that fails too, the patch is logged as made without its event.
 */
import { type NewEvent, RELEASE_TYPES, type ReleaseControl } from '@software-factory/events';
import { lineStopped } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { rolloutSchema } from '../release/read.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import { releaseName, short } from '../release/watch.ts';
import { KubeError, type KubeWriter } from '../runners/kube.ts';
import { adminEvent, appendMartins, Refused } from './store.ts';

/** The Rollout, with what a conditional patch needs. */
const rolloutWithVersion = rolloutSchema.extend({
  metadata: rolloutSchema.shape.metadata.extend({ resourceVersion: z.string() }),
});
type Rollout = z.infer<typeof rolloutWithVersion>;

/** The release in the Rollout now, as the controls see it. */
export interface Canary {
  /** Its name, as the line records it: the canary's pod-template hash and the Rollout's revision. */
  release: string;
  /** The Rollout's version, for a conditional patch. */
  resourceVersion: string;
  /** Whether a canary is out, beside the stable version, and not aborted. */
  inFlight: boolean;
  /** Whether it was aborted, by anyone or by an analysis, and not retried since. */
  aborted: boolean;
  /** Whether Martin has paused it (`spec.paused`). */
  paused: boolean;
  /** The canary's share of the traffic now. */
  weight: number;
  /** The next step that sets a weight short of 100%, if there is one after the step it is at. */
  next: { index: number; weight: number } | undefined;
}

const REVISION = 'rollout.argoproj.io/revision';

/**
 * What the controls see of a Rollout: undefined while it has no release to act on, or its status has not caught up
 * with its spec (its revision may then be the next release's).
 */
export function canaryOf(rollout: Rollout): Canary | undefined {
  const { metadata, spec, status } = rollout;
  const caughtUp =
    metadata.generation === undefined || String(status.observedGeneration) === String(metadata.generation);
  const revision = metadata.annotations[REVISION];
  const current = status.currentPodHash;
  if (!caughtUp || !current || !revision || !/^\d{1,12}$/.test(revision)) return undefined;
  const out = current !== status.stableRS;
  const aborted = status.abort === true;
  const weight = status.canary?.weights?.canary.weight ?? 0;
  const steps = spec.strategy.canary?.steps ?? [];
  const at = status.currentStepIndex ?? 0;
  const index = steps.findIndex(
    (step, i) => i > at && step.setWeight !== undefined && step.setWeight > weight && step.setWeight < 100,
  );
  const next = index === -1 ? undefined : { index, weight: steps[index]?.setWeight ?? 0 };
  return {
    release: releaseName(current, revision),
    resourceVersion: metadata.resourceVersion,
    inFlight: out && !aborted,
    aborted: out && aborted,
    paused: spec.paused === true,
    weight: aborted ? 0 : weight,
    next,
  };
}

/** The patches a control makes, the first of them conditional, and for a promotion the weight it goes to. */
export interface Plan {
  status?: Record<string, unknown>;
  spec?: Record<string, unknown>;
  to?: number;
}

/** What a control does to the canary as it is, or why it cannot. */
export function planOf(action: ReleaseControl, canary: Canary): Plan | { refused: string } {
  const notInFlight = { refused: 'No canary is in flight: the release has ended, or was stopped.' };
  // A promotion gives a paused canary back to Argo Rollouts too, as `kubectl argo rollouts promote` does.
  const resume = canary.paused ? { spec: { paused: false } } : {};
  switch (action) {
    case 'pause':
      if (!canary.inFlight) return notInFlight;
      if (canary.paused) return { refused: 'The canary is paused already.' };
      return { spec: { paused: true } };
    case 'resume':
      if (!canary.inFlight) return notInFlight;
      if (!canary.paused) return { refused: 'The canary is not paused.' };
      return { spec: { paused: false } };
    case 'abort':
      if (!canary.inFlight) return notInFlight;
      return { status: { abort: true } };
    case 'promote':
      if (!canary.inFlight) return notInFlight;
      if (!canary.next) return { refused: 'The canary has no step before all of the traffic: promote it fully.' };
      return {
        status: { pauseConditions: null, controllerPause: false, currentStepIndex: canary.next.index },
        ...resume,
        to: canary.next.weight,
      };
    case 'promote-fully':
      if (!canary.inFlight) return notInFlight;
      return { status: { promoteFull: true }, ...resume, to: 100 };
    case 'retry':
      if (!canary.aborted) return { refused: 'Only a release that was stopped can be retried.' };
      return { status: { abort: false } };
  }
}

/** The release as the line recorded it: its version, and how its latest attempt ended, if it has. */
interface Recorded {
  version: string;
  ended: 'release.promoted' | 'release.rolled-back' | 'release.aborted' | 'release.errored' | undefined;
}

const ENDS = ['release.promoted', 'release.rolled-back', 'release.aborted', 'release.errored'] as const;

/** How many times a control reads the Rollout again when it changed between the read and the patch. */
const TRIES = 3;

export interface Controlled {
  action: ReleaseControl;
  release: string;
  weight: number;
  to?: number;
}

export class ReleaseControls {
  readonly #kube: KubeWriter;
  readonly #path: string;
  readonly #sql: Sql;
  readonly #log: Logger;

  constructor(kube: KubeWriter, rollout: RolloutRef, sql: Sql, log: Logger) {
    this.#kube = kube;
    this.#path =
      `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(rollout.namespace)}` +
      `/rollouts/${encodeURIComponent(rollout.name)}`;
    this.#sql = sql;
    this.#log = log;
  }

  /** Makes a control of the release the panel showed, and records it; or refuses, having changed nothing. */
  async control(action: ReleaseControl, release: string): Promise<Controlled> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#once(action, release);
      } catch (error) {
        // The Rollout changed between the read and the patch: read it again, and decide again.
        if (!(error instanceof KubeError) || error.status !== 409) throw error;
        if (attempt < TRIES) continue;
        throw new Refused('release', 409, 'The Rollout kept changing as you pressed: look again.');
      }
    }
  }

  async #once(action: ReleaseControl, release: string): Promise<Controlled> {
    const rollout = await this.#kube.get(this.#path, rolloutWithVersion);
    if (!rollout) throw new Refused('rollout', 404, 'There is no Rollout of the app to control.');
    const canary = canaryOf(rollout);
    if (!canary) throw new Refused('release', 409, 'The Rollout is between releases: look again in a moment.');
    if (canary.release !== release) {
      throw new Refused('release', 409, 'That release is no longer the one in the Rollout: look again.');
    }
    const recorded = await this.#recorded(release);
    if (!recorded) {
      throw new Refused('release', 409, 'The line has not recorded this release yet: look again in a moment.');
    }
    if (action === 'retry') {
      if (recorded.ended === 'release.rolled-back') {
        throw new Refused(
          'release',
          409,
          'A rollback is the analysis’s: the fix goes out with the next release that carries it.',
        );
      }
      if (recorded.ended !== 'release.aborted' && recorded.ended !== 'release.errored') {
        throw new Refused('release', 409, 'The line has not recorded how this release stopped yet: look again.');
      }
      if (await lineStopped(this.#sql)) {
        throw new Refused('line', 409, 'Start the line first: a stopped line starts no canary.');
      }
    }
    const plan = planOf(action, canary);
    if ('refused' in plan) throw new Refused('release', 409, plan.refused);
    const controlled: Controlled = {
      action,
      release,
      weight: canary.weight,
      ...(plan.to !== undefined && { to: plan.to }),
    };
    const event = adminEvent('release.controlled', summaryOf(controlled, recorded.version), {
      ...controlled,
      version: recorded.version,
    });
    let patched = false;
    try {
      await this.#sql.begin(async (tx) => {
        // One control at a time, and its event appended, so a malformed one fails before anything is patched.
        await tx`select pg_advisory_xact_lock(hashtext('release-controls'))`;
        await appendMartins(this.#sql, tx, [event]);
        await this.#patch(plan, canary.resourceVersion);
        patched = true;
      });
    } catch (error) {
      if (!patched) throw kubeRefusal(error) ?? error;
      await this.#recordAlone(event);
    }
    this.#log.info({ action, release, weight: canary.weight, to: plan.to }, `Martin's ${action} of the canary`);
    return controlled;
  }

  /**
   * The plan's patches: the first conditional on the Rollout as it was read, so nothing is applied to a release that
   * moved on. A promotion's resume after it is not, and is the promotion's: if it fails, the canary was promoted, and
   * stays paused until Martin resumes it.
   */
  async #patch(plan: Plan, resourceVersion: string): Promise<void> {
    const precondition = { metadata: { resourceVersion } };
    const schema = rolloutWithVersion;
    if (plan.status) {
      await this.#kube.patch(`${this.#path}/status`, { ...precondition, status: plan.status }, schema);
      if (!plan.spec) return;
      try {
        await this.#kube.patch(this.#path, { spec: plan.spec }, schema);
      } catch (error) {
        this.#log.error({ err: error }, 'promoted the canary, and could not resume it: it stays paused');
      }
      return;
    }
    await this.#kube.patch(this.#path, { ...precondition, spec: plan.spec }, schema);
  }

  /** The event of a control whose patch was made and whose transaction did not commit, appended on its own. */
  async #recordAlone(event: NewEvent): Promise<void> {
    try {
      await this.#sql.begin((tx) => appendMartins(this.#sql, tx, [event]));
    } catch (error) {
      // Its id is the same, so one that did commit after all is refused as a repeat: either way it is recorded once.
      const recorded = await this.#sql`select 1 from events where id = ${event.id}`.catch(() => []);
      if (recorded.length) return;
      this.#log.error({ err: error, event }, 'made a control of the canary, and could not record it');
      throw error;
    }
  }

  /** What the line recorded of a release: the version from its latest start, and whether that attempt ended. */
  async #recorded(release: string): Promise<Recorded | undefined> {
    const types = RELEASE_TYPES.filter(
      (type) => type === 'release.started' || (ENDS as readonly string[]).includes(type),
    );
    const rows = await this.#sql<{ type: string; version: string }[]>`
      select type, payload->>'version' as version from events
      where type in ${this.#sql(types)} and payload->>'release' = ${release}
        and (payload->>'dryRun')::boolean is not true
      order by seq desc limit 50`;
    const started = rows.findIndex((row) => row.type === 'release.started');
    const start = rows[started];
    if (!start) return undefined;
    const end = rows.slice(0, started).find((row) => (ENDS as readonly string[]).includes(row.type));
    return { version: start.version, ended: end?.type as Recorded['ended'] };
  }
}

/** A refusal from Kubernetes, as the service says it: the policy or the Role refused the patch, and nothing changed. */
function kubeRefusal(error: unknown): Refused | undefined {
  if (!(error instanceof KubeError)) return undefined;
  if (error.status === 409) return undefined;
  if (error.kind === 'refused' || error.kind === 'invalid') {
    return new Refused('kubernetes', 502, 'Kubernetes refused the change, and nothing was done.');
  }
  return undefined;
}

/** The event's summary, in the console's words. */
export function summaryOf({ action, weight, to }: Controlled, version: string): string {
  const canary = `the canary of ${short(version)}`;
  switch (action) {
    case 'promote':
      return `Martin promoted ${canary} from ${weight}% to ${to}%`;
    case 'promote-fully':
      return `Martin promoted ${canary} fully, from ${weight}%`;
    case 'pause':
      return `Martin paused ${canary} at ${weight}%`;
    case 'resume':
      return `Martin gave ${canary} back to its analysis at ${weight}%`;
    case 'abort':
      return `Martin aborted ${canary} at ${weight}%`;
    case 'retry':
      return `Martin retried the release of ${short(version)}`;
  }
}
