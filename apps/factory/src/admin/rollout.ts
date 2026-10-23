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
 * - **Abort**: `status.abort`, and the pause cleared if Martin had paused it, so none outlives its canary. The version
 *   before takes all of the traffic at once. Nothing failed, so it is no signal; the line records `release.aborted`
 *   with `by: martin`, from this control's event.
 * - **Retry**: `status.abort` cleared, and any pause left set cleared too, for a release that was stopped (by Martin, by
 *   stopping the line, or by an analysis error), which starts again from its first step. Not while the line is stopped, which starts no canary,
 *   and never after a rollback, which is the analysis's: the fix goes out with the next release that carries it.
 *
 * There is no rollback: that stays the analysis's alone.
 *
 * Each control names the release the panel showed Martin, and is refused if another is in flight now. The first patch
 * is conditional on the Rollout being as it was read (its `resourceVersion`), so a release that moved on in between is
 * read again, and the control decided again, rather than applied to what Martin did not see.
 *
 * The control's event, `release.controlled`, is checked before the patch and appended once it is made, in a
 * transaction of its own, so a patch that fails leaves no event and no connection to the store waits on Kubernetes. A
 * patch whose answer never came is read back, and counts as made if the Rollout shows it. An append that fails is
 * tried once more, and if that fails too, the control is logged as made without its event.
 */
import { type NewEvent, RELEASE_TYPES, type ReleaseControl } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import { lineStopped } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { REVISION, recordedFrom, releaseName, short, type TargetRecord } from '../release/recorded.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import { KubeError, type KubeWriter } from '../runners/kube.ts';
import { adminEvent, appendMartins, Refused } from './store.ts';

/**
 * The Rollout, as far as the controls read it: which release is in it, where its canary is, and what a conditional
 * patch needs. A subset, as the line's is (`release/read.ts`), so a field Argo Rollouts adds or drops elsewhere changes
 * nothing here.
 */
const rolloutWithVersion = z.object({
  metadata: z.object({
    resourceVersion: z.string(),
    generation: z.number().int().optional(),
    annotations: z.record(z.string(), z.string()).default({}),
  }),
  spec: z.object({
    paused: z.boolean().optional(),
    strategy: z.object({
      canary: z.object({ steps: z.array(z.object({ setWeight: z.number().int().optional() })).default([]) }).optional(),
    }),
  }),
  status: z
    .object({
      currentPodHash: z.string().optional(),
      observedGeneration: z.union([z.string(), z.number()]).optional(),
      stableRS: z.string().optional(),
      currentStepIndex: z.number().int().optional(),
      abort: z.boolean().optional(),
      canary: z.object({ weights: z.object({ canary: z.object({ weight: z.number().int() }) }).optional() }).optional(),
    })
    .default({}),
});
type Rollout = z.infer<typeof rolloutWithVersion>;

/** The Rollout's spec and status as they are, to see whether a patch whose answer never came was made. */
const rolloutRaw = z.object({
  spec: z.record(z.string(), z.unknown()),
  status: z.record(z.string(), z.unknown()).default({}),
});

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
      // Aborted, a canary Martin paused is resumed too, so no pause outlives it into its retry or the next release.
      return { status: { abort: true }, ...resume };
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
      return { status: { abort: false }, ...resume };
  }
}

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
    const plan = planOf(action, canary);
    if ('refused' in plan) throw new Refused('release', 409, plan.refused);
    const [recorded, stopped] = await Promise.all([
      this.#recorded(release),
      action === 'retry' ? lineStopped(this.#sql) : false,
    ]);
    if (!recorded) {
      throw new Refused('release', 409, 'The line has not recorded this release yet: look again in a moment.');
    }
    if (action === 'retry') {
      if (recorded.ended === 'rolled-back') {
        throw new Refused(
          'release',
          409,
          'A rollback is the analysis’s: the fix goes out with the next release that carries it.',
        );
      }
      if (recorded.ended !== 'aborted' && recorded.ended !== 'errored') {
        throw new Refused('release', 409, 'The line has not recorded how this release stopped yet: look again.');
      }
      if (stopped) throw new Refused('line', 409, 'Start the line first: a stopped line starts no canary.');
    }
    const controlled: Controlled = {
      action,
      release,
      weight: canary.weight,
      ...(plan.to !== undefined && { to: plan.to }),
    };
    // Stamped as the patch is made, and checked before it, so a control whose event the store would refuse changes
    // nothing.
    const event = adminEvent('release.controlled', summaryOf(controlled, recorded.version), {
      ...controlled,
      version: recorded.version,
    });
    const valid = validate(event);
    if (!valid.ok) throw new Error(`a control's event is not valid: ${valid.problems.join('; ')}`);
    await this.#patch(plan, canary);
    // Made: recorded after it, in a transaction of its own, so no connection waits on Kubernetes.
    await this.#record(event);
    this.#log.info({ action, release, weight: canary.weight, to: plan.to }, `Martin's ${action} of the canary`);
    return controlled;
  }

  /**
   * The plan's patches, status first, each conditional on the Rollout as it was read for it, so nothing is applied to a
   * release that moved on. A spec patch after a status patch (a promotion's or an abort's resume, a retry's) reads the
   * Rollout again, and is made only while the same release is in it: if it cannot be, the control was made, and the
   * canary stays paused until Martin resumes it.
   *
   * A patch whose answer never came (the connection failed, or timed out), or came as a server error, may have been
   * made: the Rollout is read again, and the control counts as made if it shows the patch.
   */
  async #patch(plan: Plan, canary: Canary): Promise<void> {
    const precondition = { metadata: { resourceVersion: canary.resourceVersion } };
    const [first, then] = plan.status
      ? [{ path: `${this.#path}/status`, body: { ...precondition, status: plan.status } }, plan.spec]
      : [{ path: this.#path, body: { ...precondition, spec: plan.spec } }, undefined];
    try {
      await this.#kube.patch(first.path, first.body);
    } catch (error) {
      const answered = error instanceof KubeError && error.kind !== 'server';
      if (answered || !(await this.#shows(plan))) throw kubeRefusal(error) ?? error;
    }
    if (!then) return;
    try {
      const now = await this.#kube.get(this.#path, rolloutWithVersion);
      const still = now && canaryOf(now);
      if (still?.release !== canary.release) throw new Error('another release is in the Rollout now');
      await this.#kube.patch(this.#path, { metadata: { resourceVersion: still.resourceVersion }, spec: then });
    } catch (error) {
      this.#log.error({ err: error }, 'made a control of the canary, and could not resume it: it stays paused');
    }
  }

  /** Whether the Rollout now shows a plan's first patch: each field it sets, as it sets it. */
  async #shows(plan: Plan): Promise<boolean> {
    const now = await this.#kube.get(this.#path, rolloutRaw).catch(() => undefined);
    if (!now) return false;
    const [set, of] = plan.status ? [plan.status, now.status] : [plan.spec ?? {}, now.spec];
    return Object.entries(set).every(([field, value]) => shown(of[field], field) === value);
  }

  /**
   * The event of a control that was made, appended on its own; once more if that fails. Its id is the same each time,
   * so one that did commit after all is found, and recorded once.
   */
  async #record(event: NewEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#sql.begin((tx) => appendMartins(this.#sql, tx, [event]));
        return;
      } catch (error) {
        const recorded = await this.#sql`select 1 from events where id = ${event.id}`.catch(() => []);
        if (recorded.length) return;
        if (attempt < 2) continue;
        this.#log.error({ err: error, event }, 'made a control of the canary, and could not record it');
        throw new Refused('record', 500, 'Done, but not recorded: the store did not take the event. Look in the logs.');
      }
    }
  }

  /** What the line recorded of a release, as the line reads it (`recordedFrom`): its version, and how it ended. */
  async #recorded(release: string): Promise<{ version: string; ended: TargetRecord['ended'] } | undefined> {
    const rows = await this.#sql<{ work_item: string | null; ts: Date; type: string; payload: unknown }[]>`
      select work_item, ts, type, payload from events
      where type in ${this.#sql(RELEASE_TYPES as string[])} and payload->>'release' = ${release}
      order by seq`;
    const recorded = recordedFrom(rows.map((row) => ({ ...row, ts: new Date(row.ts).toISOString() })));
    // A release carries the same record on every work item it is on; any one will do.
    const record = [...(recorded.get(release)?.values() ?? [])].at(-1);
    if (!record || record.started.dryRun) return undefined;
    return { version: record.started.version, ended: record.ended };
  }
}

/**
 * The fields a plan sets that Argo Rollouts leaves out of the Rollout when they are false (`omitempty` on a Go bool:
 * `status.abort`, `status.controllerPause`, `status.promoteFull` and `spec.paused`), so one that is absent is false, as
 * the controller reads it. A Rollout written back from Go's types loses a false flag (a retry's `abort: false`), and
 * a control that was made would otherwise read back as not made.
 */
const FLAGS = new Set(['abort', 'controllerPause', 'promoteFull', 'paused']);

/** A field of the Rollout as a plan would set it: a flag that is absent is false, and anything else absent is null. */
function shown(value: unknown, field: string): unknown {
  return value ?? (FLAGS.has(field) ? false : null);
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
