/**
 * Martin's security events, and the holds that wait for him, counted from the stored events for the alerts that reach
 * his phone (docs/COMPONENTS/ALERTING.md). The line counts them, not the admin service, which appends most of them: a
 * compromised admin service cannot keep its own actions quiet, as it can neither reach the line nor change an event
 * once stored. Each is told from the stored event alone, never from anything the admin service says of it, and counted
 * whatever role appended it: row security keeps any role but Martin's from appending his commands, and a refused
 * append is no event.
 *
 * The security events, each a `kind`:
 * - `sign-in`: `admin.signed-in`;
 * - `passkey-enrolled` and `passkey-revoked`;
 * - `setting-changed`: every `settings.changed`;
 * - the actions the access table marks as needing the passkey again: `stepped-up` (`admin.stepped-up` itself),
 *   `release-control` (a `release.controlled` that promotes or retries), `guardrail-approved` (a `hold.answered`
 *   approving a hold whose cause is a guardrail, read from the hold it answers: the latest on its work item before it),
 *   and `line-started`.
 *
 * And every hold started, by its cause, whoever started it.
 *
 * Both are counts of what the store holds, read each time the SDK collects, as the line's stages are: a line that
 * restarts, or a second replica, reports the same figure, so a count never falls and a reader takes the `max`. Every
 * kind and cause is reported, with none as 0, so the first of each is an increase from 0 and pages too. Events commit
 * in `seq` order (0001_events.sql), so each read counts only those after the last it read, by the primary key: the
 * events table is read whole once, when the line starts. A read that fails counts nothing new, and says so, in a gauge
 * and the log: the alert on the count going stale or missing pages instead.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import { HOLD_CAUSES, type HoldCause, type ReleaseControl } from '@software-factory/events';
import type { Sql } from 'postgres';
import { GUARDRAIL_HOLDS } from '../../../../policy/access.ts';
import type { Logger } from '../log.ts';

const meter = metrics.getMeter('factory-line');

/** Every kind of security event counted, as its `kind` label. */
export const SECURITY_KINDS = [
  'sign-in',
  'passkey-enrolled',
  'passkey-revoked',
  'setting-changed',
  'stepped-up',
  'release-control',
  'guardrail-approved',
  'line-started',
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

/**
 * The controls of a release that need the passkey again, as the access table marks `release.promote` and
 * `release.retry`: a test holds the two to each other.
 */
export const STEPPED_UP_CONTROLS: readonly ReleaseControl[] = ['promote', 'promote-fully', 'retry'];

/** The event types read: each security event's, and a hold's start. */
const TYPES = [
  'admin.signed-in',
  'passkey.enrolled',
  'passkey.revoked',
  'settings.changed',
  'admin.stepped-up',
  'release.controlled',
  'hold.answered',
  'line.started',
  'hold.started',
] as const;

/** One stored event, as far as counting it goes. */
export interface Stored {
  type: string;
  /** A release control's action. */
  action?: string | null;
  /** An answer's decision. */
  decision?: string | null;
  /** A hold's cause; for an answer, the cause of the hold it answers. */
  cause?: string | null;
}

/** What a stored event counts as: a security event of a kind, a hold of a cause, or nothing. */
export function countAs(event: Stored): { kind: SecurityKind } | { hold: HoldCause } | null {
  switch (event.type) {
    case 'admin.signed-in':
      return { kind: 'sign-in' };
    case 'passkey.enrolled':
      return { kind: 'passkey-enrolled' };
    case 'passkey.revoked':
      return { kind: 'passkey-revoked' };
    case 'settings.changed':
      return { kind: 'setting-changed' };
    case 'admin.stepped-up':
      return { kind: 'stepped-up' };
    case 'line.started':
      return { kind: 'line-started' };
    case 'release.controlled':
      return STEPPED_UP_CONTROLS.includes(event.action as ReleaseControl) ? { kind: 'release-control' } : null;
    case 'hold.answered':
      return event.decision === 'approved' && (GUARDRAIL_HOLDS as readonly string[]).includes(event.cause ?? '')
        ? { kind: 'guardrail-approved' }
        : null;
    case 'hold.started':
      return {
        hold: (HOLD_CAUSES as readonly string[]).includes(event.cause ?? '') ? (event.cause as HoldCause) : 'unknown',
      };
    default:
      return null;
  }
}

/** The counts so far, and the last event they have read. */
export interface Tally {
  seq: string;
  kinds: Record<SecurityKind, number>;
  holds: Record<HoldCause, number>;
}

export const emptyTally = (): Tally => ({
  seq: '0',
  kinds: Object.fromEntries(SECURITY_KINDS.map((kind) => [kind, 0])) as Record<SecurityKind, number>,
  holds: Object.fromEntries(HOLD_CAUSES.map((cause) => [cause, 0])) as Record<HoldCause, number>,
});

/**
 * The tally with every event stored after its last added, up to the last event stored now. One statement, so what it
 * counts and the last `seq` it says it read are of one snapshot; an answer's hold is read by its work item's index.
 */
export async function readOn(sql: Sql, tally: Tally): Promise<Tally> {
  const rows = await sql<(Stored & { last: string | null })[]>`
    with upto as (select max(seq) as last from events)
    select upto.last::text as last, e.type, e.payload->>'action' as action, e.payload->>'decision' as decision,
           case when e.type = 'hold.answered' then
             (select h.payload->>'cause' from events h
              where h.work_item = e.work_item and h.type = 'hold.started' and h.seq < e.seq
              order by h.seq desc limit 1)
           else e.payload->>'cause' end as cause
    from upto left join events e
      on e.seq > ${tally.seq}::bigint and e.seq <= upto.last and e.type in ${sql([...TYPES])}`;
  const next: Tally = { seq: rows[0]?.last ?? tally.seq, kinds: { ...tally.kinds }, holds: { ...tally.holds } };
  for (const row of rows) {
    if (!row.type) continue;
    const counted = countAs(row);
    if (counted && 'kind' in counted) next.kinds[counted.kind] += 1;
    else if (counted) next.holds[counted.hold] += 1;
  }
  return next;
}

const securityEvents = meter.createObservableCounter('line.security_events', {
  description: 'Martin’s security events the store holds, by kind: sign-ins, passkeys, settings and stepped-up actions',
});

const holdsStored = meter.createObservableCounter('line.holds.stored', {
  description: 'Holds for Martin the store holds, by cause, whoever started them',
});

const counting = meter.createObservableGauge('line.security_events.counting', {
  description: 'Whether the last read of Martin’s security events from the store succeeded: 1 if it did, 0 if not',
});

/**
 * Reports the counts from the store each time the SDK collects, until the function it gives back is called. A read
 * that fails reports no new count, and says so: `line.security_events.counting` is 0, and the log says it once until a
 * read succeeds again. The SDK goes on sending the last count it had, so the gauge, not the count, says it is stale.
 */
export function observeSecurity(sql: Sql, log: Logger): () => void {
  let tally = emptyTally();
  let failing = false;
  const callback = async (result: BatchObservableResult) => {
    try {
      tally = await readOn(sql, tally);
    } catch (error) {
      if (!failing) log.warn({ err: error }, 'could not count Martin’s security events: the count is stale');
      failing = true;
      result.observe(counting, 0);
      return;
    }
    if (failing) log.info('counting Martin’s security events again');
    failing = false;
    result.observe(counting, 1);
    for (const kind of SECURITY_KINDS) result.observe(securityEvents, tally.kinds[kind], { kind });
    for (const cause of HOLD_CAUSES) result.observe(holdsStored, tally.holds[cause], { cause });
  };
  const observed = [securityEvents, holdsStored, counting];
  meter.addBatchObservableCallback(callback, observed);
  return () => meter.removeBatchObservableCallback(callback, observed);
}
