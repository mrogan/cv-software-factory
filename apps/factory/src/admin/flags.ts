/**
 * Martin's stages of the feature flags, from the console's Controls: `POST /admin/flags/:flag/stage`, with the stage
 * the slider showed the flag at, the stage he chose, and his reason, which turning it off requires. The admin service
 * writes `flags`, the one FeatureFlag flagd watches, as its own service account, whose Role may get and update that
 * one object (deploy/base/flagd/admin-stages-flags.yaml), and whose every change an admission policy holds to the
 * stages' shapes (deploy/base/admission/flagd/flag-stages.yaml), rendered by `policy/flags.ts`.
 *
 * - **Judged from what is so.** The flag's stage is read from `flags`, never the request's word; a move from a stage
 *   other than the one the slider showed is refused, as a release control naming another release is. What the move
 *   is (`flag.to-checks`, `flag.widen`, `flag.back-on`, `flag.narrow` or `flag.off`), and whether it can be taken now,
 *   is `policy/flag-moves.ts`'s, which the console draws each stop from too: the passkey again when that action needs
 *   it, a canary in flight read from the app's Rollout (`rollout.ts`), another flag at Share read from `flags`, and
 *   Martin's last move of the flag and Verify's comparison since, from the store. A move to where the flag is already
 *   records nothing.
 * - **The write.** `flags` is read, the one flag changed and every other flag kept at its stage, read back through
 *   `readFlags` and rendered again, so a flag in no stage's shape is never written back (it is dropped, which turns it
 *   off, and the answer names it), with a new `flag-set-revision`, and replaced whole, conditional on the
 *   `resourceVersion` it read. When `flags` changed in between, it is read again and the move judged again, up to
 *   three times, so two moves at once never lose one.
 * - **Recorded once made,** as a control of the canary is: `flag.staged` is checked before the write, and appended
 *   after it, in a transaction of its own, so a write Kubernetes refuses leaves no event (502), and no connection to
 *   the store waits on Kubernetes. A write whose answer never came is read back, and counts as made if `flags` holds
 *   the revision it wrote. An append that fails is tried once more, and if that fails too, the move stands in `flags`,
 *   is logged, and the answer says it was not recorded (500). Martin's last move then lags `flags`, and what depends
 *   on it (turning back on, Everyone) is refused until a move is recorded again.
 */
import { type NewEvent, VERSIONS } from '@software-factory/events';
import { PAYLOADS } from '@software-factory/events/schemas';
import { fromMartin } from '@software-factory/store';
import type { Logger } from 'pino';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { ACCESS, STEP_UP } from '../../../../policy/access.ts';
import {
  type Around,
  type FlagAction,
  type FlagNow,
  flagAction,
  moveOf,
  sameStage,
  stageWords,
} from '../../../../policy/flag-moves.ts';
import { flagsSpec, isFlagName, readFlags, type Share, type Stage } from '../../../../policy/flags.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import { KubeError, type KubeWriter } from '../runners/kube.ts';
import type { ReleaseControls } from './rollout.ts';
import { adminEvent, appendMade, checked, Refused, type Session } from './store.ts';

/** A stage as the slider sends it: a share is checked against policy's, and refused if it is not one. */
const stage = z.discriminatedUnion('stage', [
  z.strictObject({ stage: z.enum(['off', 'checks', 'preview', 'everyone']) }),
  z.strictObject({ stage: z.literal('share'), share: z.number() }),
]);

/** A move, as the console sends it: the stage the slider showed (none: outside every stage), the one chosen, and why. */
export const MOVE = z.strictObject({
  from: stage.nullable(),
  to: stage,
  reason: PAYLOADS['line.stopped'].shape.reason.optional(),
});
export type Asked = z.infer<typeof MOVE>;

/** What a move did. */
export interface Staged {
  /** The move, or none when the flag was at that stage already. */
  staged: { flag: string; from: Stage | null; to: Stage; action: FlagAction; revision: string } | null;
  /** The flags `flags` held in no stage's shape, which the write dropped, and so turned off. */
  dropped?: string[];
}

/** `flags` as read: the whole object, written back with its flags replaced. */
const featureFlag = z.looseObject({
  metadata: z.looseObject({ resourceVersion: z.string() }),
  spec: z.looseObject({ flagSpec: z.looseObject({ flags: z.unknown().optional() }).optional() }),
});
type FeatureFlag = z.infer<typeof featureFlag>;

/** How many times a move reads `flags` again when it changed between the read and the write. */
const TRIES = 3;

/** The role whose events of Verify's, and records of the planner's specs, the admin service believes: the line's. */
const LINE_ROLE = 'factory_line';

/** The next revision of the flag set: `r1`, `r2`, …, counting on from the one `flags` holds. */
export function nextRevision(held: string | undefined): string {
  const n = Number(/^r(\d{1,9})$/.exec(held ?? '')?.[1] ?? 0);
  return `r${n + 1}`;
}

/** The summary of a move, in the console's words. */
export function stagedSummary(flag: string, action: FlagAction, from: Stage | null, to: Stage): string {
  switch (action) {
    case 'flag.to-checks':
    case 'flag.widen':
      return `Martin widened ${flag} from ${stageWords(from)} to ${stageWords(to)}`;
    case 'flag.back-on':
      return `Martin turned ${flag} back on for everyone`;
    case 'flag.narrow':
      return `Martin narrowed ${flag} from ${stageWords(from)} to ${stageWords(to)}`;
    case 'flag.off':
      return `Martin turned ${flag} off, from ${stageWords(from)}`;
  }
}

export class FlagStages {
  readonly #kube: KubeWriter;
  readonly #path: string;
  readonly #sql: Sql;
  readonly #log: Logger;
  readonly #releases: ReleaseControls | undefined;

  constructor(kube: KubeWriter, flags: RolloutRef, sql: Sql, log: Logger, releases?: ReleaseControls) {
    this.#kube = kube;
    this.#path =
      `/apis/core.openfeature.dev/v1beta1/namespaces/${encodeURIComponent(flags.namespace)}` +
      `/featureflags/${encodeURIComponent(flags.name)}`;
    this.#sql = sql;
    this.#log = log;
    this.#releases = releases;
  }

  /** Sets a flag's stage, and records it; or refuses, having changed nothing. */
  async stage(session: Session, flag: string, asked: Asked): Promise<Staged> {
    if (!isFlagName(flag)) throw new Refused('flag', 404, 'That is no flag of the app’s.');
    if (asked.to.stage === 'off' && !asked.reason) {
      throw new Refused('body', 400, 'Give a reason for turning it off, for the audit log and the work item.');
    }
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#once(session, flag, asked);
      } catch (error) {
        if (!(error instanceof KubeError) || error.status !== 409) throw error;
        if (attempt < TRIES) continue;
        throw new Refused('flags', 409, 'The flags kept changing as you pressed: look again.');
      }
    }
  }

  async #once(session: Session, flag: string, asked: Asked): Promise<Staged> {
    const read = await this.#kube.get(this.#path, featureFlag);
    if (!read) throw new Refused('flags', 503, 'There is no `flags` for the admin service to write.');
    const held = readFlags(read.spec);
    const stage: Stage | null = held.outside.includes(flag) ? null : (held.stages[flag] ?? { stage: 'off' });
    if (!sameStage(stage, asked.from as Stage | null)) {
      throw new Refused(
        'flag',
        409,
        `${flag} is at ${stageWords(stage)} now, not ${stageWords(asked.from as Stage | null)}: look again.`,
      );
    }
    const to = asked.to as Stage;
    const action = flagAction(stage, to);
    if (action === undefined) return { staged: null };

    const now: FlagNow = { stage, ...(await this.#history(flag, stage)) };
    const intoShare = to.stage === 'share' && stage?.stage !== 'share';
    const around: Around = intoShare ? await this.#around(flag, held.stages) : {};
    const move = moveOf(flag, now, to, around);
    if (move.refused) throw new Refused('stage', 409, move.refused);
    const steppedUp = await this.#steppedUp(session);
    if (ACCESS[action].stepUp && !steppedUp) throw new Refused('step-up', 403, 'This needs your passkey again.');

    const revision = nextRevision(held.revision);
    const rendered = flagsSpec({ ...held.stages, [flag]: to }, revision).flagSpec.flags;
    const dropped = held.outside.filter((name) => name !== flag && isFlagName(name));
    // Checked before the write, so a move whose event the store would refuse changes nothing.
    const event = checked(
      adminEvent(
        'flag.staged',
        stagedSummary(flag, action, stage, to),
        {
          flag,
          from: stage as PayloadOfStaged['from'],
          to: to as PayloadOfStaged['to'],
          revision,
          ...(asked.reason && { reason: asked.reason }),
          steppedUp,
        },
        now.workItem,
      ),
    );
    await this.#write(read, rendered, revision);
    if (dropped.length) this.#log.warn({ dropped }, 'dropped flags held in no stage’s shape, turning them off');
    await this.#record(event);
    this.#log.info({ flag, from: stage, to, revision }, `Martin's ${action} of a flag`);
    return { staged: { flag, from: stage, to, action, revision }, ...(dropped.length && { dropped }) };
  }

  /**
   * What the store says of a flag: the improvement whose latest spec names it, Martin's last move of it, and Verify's
   * latest comparison since. A last move that is not the stage `flags` holds (its event not recorded) says nothing of
   * the flag as it stands, so neither it nor a comparison since counts.
   */
  async #history(flag: string, stage: Stage | null): Promise<Omit<FlagNow, 'stage'>> {
    const sql = this.#sql;
    const [named] = await sql<{ work_item: string }[]>`
      with specs as (
        select distinct on (s.work_item) s.work_item, s.seq, s.payload->>'flag' as flag
        from events s
        where s.type = 'spec.written' and s.appended_by = ${LINE_ROLE} and s.work_item is not null and not s.sample
        order by s.work_item, s.seq desc
      )
      select p.work_item from specs p
      where p.flag = ${flag}
        and exists (select 1 from events o where o.type = 'work-item.opened' and o.work_item = p.work_item
                    and o.payload->>'kind' = 'improvement' and not o.sample)
      order by p.seq desc limit 1`;
    const [last] = await sql<{ seq: string; payload: { from: Stage | null; to: Stage } }[]>`
      select e.seq::text as seq, e.payload from events e
      where e.type = 'flag.staged' and e.payload->>'flag' = ${flag} and e.version <= ${VERSIONS['flag.staged']}
        and e.appended_by is not null and ${fromMartin(sql, 'e')} and not e.sample
      order by e.seq desc limit 1`;
    const current = last && sameStage(last.payload.to, stage);
    const [compared] = current
      ? await sql<{ payload: { share: Share; outcome: 'passed' | 'failed' } }[]>`
          select e.payload from events e
          where e.type = 'flag.compared' and e.payload->>'flag' = ${flag} and e.version <= ${VERSIONS['flag.compared']}
            and e.appended_by = ${LINE_ROLE} and e.seq > ${last.seq}::bigint and not e.sample
          order by e.seq desc limit 1`
      : [];
    return {
      ...(named && { workItem: named.work_item }),
      ...(current && { last: { from: last.payload.from, to: last.payload.to } }),
      ...(compared && { compared: { share: compared.payload.share, outcome: compared.payload.outcome } }),
    };
  }

  /** What a move into Share waits for: another flag there, and a canary in flight, or not knowing. */
  async #around(flag: string, stages: Record<string, Stage>): Promise<Around> {
    const atShare = Object.entries(stages).find(([name, s]) => name !== flag && s.stage === 'share')?.[0];
    if (atShare) return { atShare };
    if (!this.#releases) return { canary: 'unknown' };
    try {
      const canary = await this.#releases.inFlight();
      return canary ? { canary } : {};
    } catch (error) {
      this.#log.warn({ err: error }, 'could not tell whether a canary is in flight');
      return { canary: 'unknown' };
    }
  }

  /** Whether the session's passkey was given again within five minutes, by the store's clock, as the move is taken. */
  async #steppedUp(session: Session): Promise<boolean> {
    const [row] = await this.#sql<{ fresh: boolean }[]>`
      select coalesce(s.stepped_up_at > now() - make_interval(mins => ${STEP_UP.minutes}), false) as fresh
      from sessions s join passkeys p on p.id = s.passkey
      where s.id_sha256 = ${session.hash} and s.ended_at is null and s.expires_at > now() and p.revoked_at is null`;
    if (!row) throw new Refused('session', 401, 'Sign in first: the session has ended.');
    return row.fresh;
  }

  /**
   * Replaces `flags` with these flags, conditional on the object as it was read. A write whose answer never came, or
   * came as a server error, may have been made: `flags` is read again, and counts as made if it holds this revision.
   */
  async #write(read: FeatureFlag, flags: Record<string, unknown>, revision: string): Promise<void> {
    const body = { ...read, spec: { ...read.spec, flagSpec: { ...read.spec.flagSpec, flags } } };
    try {
      await this.#kube.replace(this.#path, body);
    } catch (error) {
      if (error instanceof KubeError && error.kind !== 'server') {
        if (error.status === 409) throw error;
        throw new Refused('kubernetes', 502, 'Kubernetes refused the change, and nothing was done.');
      }
      const now = await this.#kube.get(this.#path, featureFlag).catch(() => undefined);
      if (!now || readFlags(now.spec).revision !== revision) throw error;
    }
  }

  async #record(event: NewEvent): Promise<void> {
    try {
      await appendMade(this.#sql, event);
    } catch (error) {
      this.#log.error({ err: error, event }, "set a flag's stage, and could not record it");
      throw new Refused('record', 500, 'Done, but not recorded: the store did not take the event. Look in the logs.');
    }
  }
}

type PayloadOfStaged = z.infer<(typeof PAYLOADS)['flag.staged']>;
