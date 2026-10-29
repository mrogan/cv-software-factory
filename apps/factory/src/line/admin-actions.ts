/**
 * Whether every change the admin service makes is named by an event (docs/COMPONENTS/ALERTING.md, "Changes no event
 * names"). The security events are counted from the store, so an action the admin service took without appending its
 * event would be counted nowhere. The line compares what the admin service changes with the events that name each
 * change, for the alert that pages Martin when one is not: the line, as it counts the security events, since a
 * compromised admin service can neither reach the line nor change an event once stored.
 *
 * - **The flags** (`flags` in `flagd`, FEATURE_FLAGS): each flag at the stage Martin's latest move of it put it, every
 *   other flag off, none in a shape no stage has, and the flag set's revision one a move of his wrote. A move's
 *   `flag.staged` names the revision it wrote and the stage it set, and any flag it dropped.
 * - **The Rollout's controls** (RELEASE_ROLLOUT): the fields a control sets that nothing else does. `spec.paused` is set
 *   only after his latest pause or resume was a pause, and cleared only after something that clears it (a resume, a
 *   promotion, an abort, a retry or the line stopped) has followed his latest pause; `status.promoteFull` is set only
 *   after a full promotion of his since the line recorded the latest release start. The status's abort and step are
 *   written by Argo Rollouts' controller too, so the Rollout cannot say who moved them: admission holds the admin
 *   service to the moves the controls make, and the line records what each release did.
 * - **Sessions:** every session signed in within the last hour has a sign-in of its own (`admin.signed-in`), appended
 *   in the same transaction, so at or within a minute after the session's start, each sign-in naming one session. An
 *   hour, so a session made and ended at once is still compared, and the alert resolves an hour after.
 *
 * Only events one of Martin's roles appended name a change, and never a sample's. The admin service appends its
 * event once the change is made, checked before it so the store takes it (`admin/flags.ts`, `admin/rollout.ts`), so a
 * change stands unnamed for the moment between the two, and for good if the append fails twice; Kubernetes is read
 * first, then the store, and the alert waits two minutes, so only one never recorded pages. A change that failed after
 * its event was checked has no event, and changes nothing to name.
 *
 * Each is compared each time the SDK collects, and reported as `line.admin_actions.uncounted` (1 if a change is not
 * named, 0 if every one is) and `line.admin_actions.compared` (1 if this comparison was made, 0 if a read failed), by
 * `action`. A comparison that cannot be made reports nothing new of what it compares (the SDK sends the last figure
 * again), and is logged once until it can; a change no event names is logged once until it is named.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import { upcast } from '@software-factory/events';
import { byMartin } from '@software-factory/store';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { sameStage } from '../../../../policy/flag-moves.ts';
import { readFlags, type Stage } from '../../../../policy/flags.ts';
import type { Logger } from '../log.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import type { Kube } from '../runners/kube.ts';

const meter = metrics.getMeter('factory-line');

/** What the admin service changes, as each comparison's `action` label. */
export const ADMIN_ACTIONS = ['flags', 'rollout', 'sessions'] as const;
export type AdminAction = (typeof ADMIN_ACTIONS)[number];

/** How long after a session starts its sign-in may be appended: the one transaction that starts it, waiting its turn. */
export const SIGN_IN_WITHIN_MS = 60_000;

/** How far back sessions are compared: long enough that a session made and ended at once is still there to compare. */
export const SESSIONS_LOOKBACK = '1 hour';

/** The role whose records of a release's start the line believes: its own. */
const LINE_ROLE = 'factory_line';

const OFF: Stage = { stage: 'off' };

/** Martin's move of a flag, as its `flag.staged` stores it. */
export interface Move {
  flag: string;
  to: Stage;
  revision: string;
  dropped?: string[];
}

/** `flags` as `readFlags` reads it. */
export type HeldFlags = ReturnType<typeof readFlags>;

/**
 * Whether every flag `flags` holds, and its revision, is named by Martin's moves, oldest first: each flag at the stage
 * his latest move of it set, and off if none did or a later move dropped it; none in a shape no stage has, which only a
 * hand could write; and the revision one a move wrote. A `flags` with no flag and no revision, as Argo CD makes it,
 * names nothing, and needs no event.
 */
export function flagsNamed(held: HeldFlags, moves: readonly Move[]): boolean {
  if (held.outside.length > 0) return false;
  const expected = new Map<string, Stage>();
  for (const move of moves) {
    for (const name of move.dropped ?? []) expected.delete(name);
    expected.set(move.flag, move.to);
  }
  for (const name of new Set([...expected.keys(), ...Object.keys(held.stages)])) {
    if (!sameStage(held.stages[name] ?? OFF, expected.get(name) ?? OFF)) return false;
  }
  if (held.revision === undefined) return Object.keys(held.stages).length === 0;
  return moves.some((move) => move.revision === held.revision);
}

/** What the Rollout's controls set that nothing else does. */
export interface RolloutControls {
  paused: boolean;
  promoteFull: boolean;
}

/**
 * An event that names, or clears, a control of the Rollout, oldest first: Martin's control (its action), the line
 * stopped, whose abort clears a pause even of a release the line has not recorded, or a release the line recorded
 * starting.
 */
export type ControlEvent =
  | { type: 'release.controlled'; action: string }
  | { type: 'line.stopped' }
  | { type: 'release.started' };

/**
 * Whether the Rollout's pause and full promotion are named by Martin's controls, oldest first:
 *
 * - paused, only if his latest pause or resume was a pause. A promotion, an abort or a retry that could not clear his
 *   pause leaves it set (`STILL_PAUSED`), so they are not read here;
 * - not paused, only if something that clears a pause followed his latest pause, or he never paused it;
 * - promoted fully, only if he promoted fully since the line recorded the latest release starting.
 */
export function rolloutNamed(rollout: RolloutControls, events: readonly ControlEvent[]): boolean {
  const action = (event: ControlEvent | undefined) => (event?.type === 'release.controlled' ? event.action : undefined);
  const pauses = events.filter((e) => ['pause', 'resume'].includes(action(e) ?? ''));
  const lastPause = events.findLastIndex((e) => action(e) === 'pause');
  const cleared = events.slice(lastPause + 1).some((e) => e.type !== 'release.started');
  const paused = rollout.paused ? action(pauses.at(-1)) === 'pause' : lastPause === -1 || cleared;
  const since = events.slice(events.findLastIndex((e) => e.type === 'release.started') + 1);
  const promoted = !rollout.promoteFull || since.some((e) => action(e) === 'promote-fully');
  return paused && promoted;
}

/**
 * How many sessions have no sign-in of their own: each session's sign-in appended at or within `within` after it
 * started, each sign-in naming one session. Both by the store's clock, in milliseconds. Each session, oldest first,
 * takes the earliest sign-in left that could be its own, which names as many as any matching could, since every
 * session's span is as long.
 */
export function sessionsUnnamed(
  sessions: readonly number[],
  signIns: readonly number[],
  within = SIGN_IN_WITHIN_MS,
): number {
  const started = [...sessions].sort((a, b) => a - b);
  const appended = [...signIns].sort((a, b) => a - b);
  let next = 0;
  let unnamed = 0;
  for (const at of started) {
    while (next < appended.length && (appended[next] as number) < at) next++;
    if (next < appended.length && (appended[next] as number) <= at + within) next++;
    else unnamed++;
  }
  return unnamed;
}

const featureFlag = z.looseObject({
  spec: z.looseObject({ flagSpec: z.looseObject({ flags: z.unknown().optional() }).optional() }).optional(),
});

const rolloutControls = z.looseObject({
  spec: z.looseObject({ paused: z.boolean().optional() }),
  status: z.looseObject({ promoteFull: z.boolean().optional() }).optional(),
});

/** Where each is read from: the flags and the Rollout, when the line is given them. */
export interface Compared {
  sql: Sql;
  kube: Kube;
  flags: RolloutRef | null;
  rollout: RolloutRef | null;
}

/** Whether `flags`, read first, is named by Martin's moves: with no `flags` there is nothing to name. */
export async function compareFlags({ sql, kube, flags }: Compared & { flags: RolloutRef }): Promise<boolean> {
  const read = await kube.get(
    `/apis/core.openfeature.dev/v1beta1/namespaces/${encodeURIComponent(flags.namespace)}` +
      `/featureflags/${encodeURIComponent(flags.name)}`,
    featureFlag,
  );
  if (!read) return true;
  const rows = await sql<{ version: number; payload: Record<string, unknown> }[]>`
    select e.version, e.payload from events e
    where e.type = 'flag.staged' and ${byMartin(sql, 'e')}
    order by e.seq`;
  const moves = rows.flatMap((row): Move[] => {
    const read = upcast({ type: 'flag.staged', version: row.version, payload: row.payload });
    return read.ok ? [read.event.payload as Move] : [];
  });
  return flagsNamed(readFlags(read.spec), moves);
}

/** Whether the Rollout's controls, read first, are named by Martin's: with no Rollout there is nothing to name. */
export async function compareRollout({ sql, kube, rollout }: Compared & { rollout: RolloutRef }): Promise<boolean> {
  const read = await kube.get(
    `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(rollout.namespace)}` +
      `/rollouts/${encodeURIComponent(rollout.name)}`,
    rolloutControls,
  );
  if (!read) return true;
  const events = await sql<ControlEvent[]>`
    select e.type, e.payload->>'action' as action from events e
    where not e.sample
      and ((e.type in ('release.controlled', 'line.stopped') and ${byMartin(sql, 'e')})
        or (e.type = 'release.started' and e.appended_by = ${LINE_ROLE}
            and coalesce(e.payload->>'dryRun', 'false') = 'false'))
    order by e.seq`;
  return rolloutNamed({ paused: read.spec.paused === true, promoteFull: read.status?.promoteFull === true }, events);
}

/** Whether every session of the last hour has its sign-in, both read in one statement, so of one snapshot. */
export async function compareSessions({ sql }: Pick<Compared, 'sql'>): Promise<boolean> {
  const [row] = await sql<{ sessions: Date[]; sign_ins: Date[] }[]>`
    select
      array(select s.signed_in_at from sessions s
            where s.signed_in_at > now() - ${SESSIONS_LOOKBACK}::interval) as sessions,
      array(select e.appended_at from events e
            where e.type = 'admin.signed-in' and ${byMartin(sql, 'e')}
              and e.appended_at > now() - ${SESSIONS_LOOKBACK}::interval) as sign_ins`;
  const ms = (dates: Date[] | undefined) => (dates ?? []).map((date) => new Date(date).getTime());
  return sessionsUnnamed(ms(row?.sessions), ms(row?.sign_ins)) === 0;
}

const uncounted = meter.createObservableGauge('line.admin_actions.uncounted', {
  description:
    'Whether the admin service changed something no event names, by what: the flags, the app’s Rollout or a session. 1 if so, 0 if not',
});

const compared = meter.createObservableGauge('line.admin_actions.compared', {
  description:
    'Whether the last comparison of what the admin service changes with its events was made: 1 if so, 0 if not',
});

/**
 * Compares each time the SDK collects, until the function it gives back is called: the flags and the Rollout only when
 * the line is given them, the sessions always. A comparison that fails reports 0 for `compared`, and nothing new for
 * `uncounted`, and is logged once until it is made again.
 */
export function observeAdminActions(where: Compared, log: Logger): () => void {
  const failing = new Set<AdminAction>();
  const unnamed = new Set<AdminAction>();
  const { flags, rollout } = where;
  const comparisons = new Map<AdminAction, () => Promise<boolean>>();
  if (flags) comparisons.set('flags', () => compareFlags({ ...where, flags }));
  if (rollout) comparisons.set('rollout', () => compareRollout({ ...where, rollout }));
  comparisons.set('sessions', () => compareSessions(where));
  const callback = async (result: BatchObservableResult) => {
    await Promise.all(
      [...comparisons].map(async ([action, compare]) => {
        let named: boolean;
        try {
          named = await compare();
        } catch (error) {
          if (!failing.has(action))
            log.warn({ err: error, action }, 'could not compare what the admin service changed');
          failing.add(action);
          result.observe(compared, 0, { action });
          return;
        }
        if (failing.delete(action)) log.info({ action }, 'comparing what the admin service changed again');
        if (!named && !unnamed.has(action)) log.warn({ action }, 'the admin service changed something no event names');
        if (named && unnamed.has(action)) log.info({ action }, 'what the admin service changed is named again');
        if (named) unnamed.delete(action);
        else unnamed.add(action);
        result.observe(compared, 1, { action });
        result.observe(uncounted, named ? 0 : 1, { action });
      }),
    );
  };
  const observed = [uncounted, compared];
  meter.addBatchObservableCallback(callback, observed);
  return () => meter.removeBatchObservableCallback(callback, observed);
}
