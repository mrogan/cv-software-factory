/**
 * Answering a hold from Needs you: Martin approves it, rejects it, or answers it in words, and the admin service
 * appends his `hold.answered`, which the line or triage acts on as `ANSWERS` says for the hold's cause. One route each,
 * `POST /admin/holds/:workItem/approve`, `/reject` and `/answer`, each naming the hold the card showed (its
 * `hold.started` event's id).
 *
 * - **Only the hold the card showed.** The answer is refused, having changed nothing, unless that hold is the work
 *   item's open one as the answer is taken, as the line reads it: its latest hold, with nothing since that answered
 *   or ended it (an answer, a merge, a close, a reopening, for a deploy a release, for a merge gates that failed). Words on one of triage's holds leave it open (`WORDS_LEAVE_HELD`), so it can still be
 *   approved or rejected. Answers are taken one at a time, under the lock every append takes, so two cannot both
 *   answer one hold, and a hold the line or triage appends meanwhile is the one answered next.
 * - **Only an answer that does something.** One the line would only wait after is refused (`answersTo`): approving a
 *   merge, which Martin does on GitHub, a deploy, which a release ends by itself, or a suggestion, before improvements.
 * - **The cause is the store's.** Approving a hold whose cause is a guardrail is `hold.approve-guardrail` in the access
 *   table, which needs the passkey again; the cause is read from the stored hold, never taken from the request.
 *   Rejecting, words, and approving any other cause never ask.
 * - **Words about a visitor's report stay Martin's.** On a work item a visitor's report opened (its first signal is a
 *   report), the answer is marked `report`, and its public view leaves his words out, at any stage: a paraphrase of a
 *   report would pass any redactor.
 */
import { randomUUID } from 'node:crypto';
import {
  answersTo,
  type HoldAnswer,
  type HoldCause,
  type NewEvent,
  type RawEvent,
  upcast,
  VERSIONS,
  WORDS_LEAVE_HELD,
} from '@software-factory/events';
import { fromMartin } from '@software-factory/store';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import { ACCESS, GUARDRAIL_HOLDS, STEP_UP } from '../../../../policy/access.ts';
import { type AdminStore, Refused, type Session } from './store.ts';

/** A work item's number, as the store keeps it. */
export const WORK_ITEM = /^[1-9][0-9]{0,8}$/;

/** What an answer sends: the hold the card showed, and for words, the words. */
export const ANSWER = {
  approved: z.strictObject({ hold: z.uuid() }),
  rejected: z.strictObject({ hold: z.uuid() }),
  answered: z.strictObject({ hold: z.uuid(), words: z.string().trim().min(1).max(300) }),
} satisfies Record<HoldAnswer, z.ZodType>;

/** What an answer did: the work item, the hold, the answer, and whether Martin's words stay his. */
export interface Answered {
  workItem: string;
  hold: string;
  decision: HoldAnswer;
  report: boolean;
}

/** A work item's open hold: its event's id, and its cause. */
interface OpenHold {
  id: string;
  cause: HoldCause;
}

/**
 * The work item's open hold, if it has one: its latest `hold.started`, and nothing since that answers or ends it, as the
 * line's `fold` (`line/machine.ts`) reads them. The admin service keeps its own reading, of these few events, rather
 * than take in the line's code, its GitHub and Kubernetes clients with it; `admin.test.ts` holds the two to each other
 * case by case. Only Martin's roles' answers count, as the line and triage count them.
 */
async function openHold(tx: TransactionSql, workItem: string): Promise<OpenHold | undefined> {
  const rows = await tx<(RawEvent & { id: string })[]>`
    select e.id, e.seq, e.type, e.version, e.payload from events e
    where e.work_item = ${workItem} and ${fromMartin(tx, 'e')}
      and e.type in ('hold.started', 'hold.answered', 'gates.started', 'gates.finished', 'pull-request.merged',
                     'release.started', 'release.rolled-back', 'release.aborted', 'release.errored',
                     'work-item.closed', 'work-item.reopened')
    order by e.seq`;
  let open: OpenHold | undefined;
  // The release carrying the merged change, while it has not ended, and the commit the latest gates ran on.
  let release: { name: string; ended: boolean } | undefined;
  let gates: string | undefined;
  for (const row of rows) {
    const read = upcast({ ...row, seq: Number(row.seq) });
    if (!read.ok) continue;
    const { event } = read;
    switch (event.type) {
      case 'hold.started':
        // A hold for a deploy decided as a release started is already answered by it.
        if (event.payload.cause === 'deploy' && release && !release.ended) break;
        open = { id: row.id, cause: event.payload.cause };
        break;
      case 'hold.answered':
        // Words leave one of triage's holds standing, for his approval or rejection.
        if (event.payload.decision === 'answered' && open && WORDS_LEAVE_HELD.includes(open.cause)) break;
        open = undefined;
        break;
      case 'gates.started':
        gates = event.payload.commit;
        break;
      // Gates that fail end a wait for his merge, which GitHub would refuse.
      case 'gates.finished':
        if (event.payload.commit === gates && event.payload.conclusion === 'failed' && open?.cause === 'merge') {
          open = undefined;
        }
        break;
      case 'pull-request.merged':
        open = undefined;
        release = undefined;
        break;
      // A release that carries the merged change ends a wait for its deploy.
      case 'release.started':
        if (!rows.some((r) => r.type === 'pull-request.merged' && Number(r.seq) < Number(row.seq))) break;
        release = { name: event.payload.release, ended: false };
        if (open?.cause === 'deploy') open = undefined;
        break;
      case 'release.rolled-back':
      case 'release.aborted':
      case 'release.errored':
        if (release?.name === event.payload.release) release = { ...release, ended: true };
        break;
      case 'work-item.closed':
      case 'work-item.reopened':
        open = undefined;
        break;
    }
  }
  return open;
}

/** Whether a visitor's report opened the work item: its first signal is a report. */
async function openedByReport(tx: TransactionSql, workItem: string): Promise<boolean> {
  const [first] = await tx<{ sense: string }[]>`
    select payload->>'sense' as sense from events
    where work_item = ${workItem} and type = 'signal.received' order by seq limit 1`;
  return first?.sense === 'report';
}

const DID: Record<HoldAnswer, string> = {
  approved: 'approved',
  rejected: 'rejected',
  answered: 'answered in words',
};

/** Martin's answer, as he gave it. */
function answerEvent(workItem: string, decision: HoldAnswer, hold: string, report: boolean, words?: string): NewEvent {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type: 'hold.answered',
    version: VERSIONS['hold.answered'],
    actor: 'martin',
    summary: `Martin ${DID[decision]} the hold on #${workItem}`,
    payload: { decision, ...(words !== undefined && { answer: words }), hold, ...(report && { report: true }) },
    artifacts: [],
  } as NewEvent;
}

/** Answers a work item's open hold as Martin gave it, or refuses having changed nothing. */
export async function answerHold(
  store: AdminStore,
  session: Session,
  workItem: string,
  decision: HoldAnswer,
  given: { hold: string; words?: string },
): Promise<Answered> {
  const { report } = await store.record(
    async (tx) => {
      // One answer at a time, and none between a hold the line or triage appends and the next.
      await tx`select pg_advisory_xact_lock(hashtext('events'))`;
      const open = await openHold(tx, workItem);
      if (!open || open.id !== given.hold) {
        throw new Refused(
          'hold',
          409,
          open
            ? `#${workItem} is held for something else now: look at its card again.`
            : `#${workItem} has no hold waiting now: it was answered, or moved on.`,
        );
      }
      if (!answersTo(open.cause).includes(decision)) {
        throw new Refused('answer', 422, 'That answer does nothing for this hold, so it takes another.');
      }
      const guardrail = (GUARDRAIL_HOLDS as readonly HoldCause[]).includes(open.cause);
      if (decision === 'approved' && guardrail && ACCESS['hold.approve-guardrail'].stepUp) {
        // Asked again as the answer is taken, after the lock: the passkey given may have gone stale while it waited.
        const [fresh] = await tx`
          select 1 from sessions where id_sha256 = ${session.hash} and ended_at is null
            and stepped_up_at > now() - make_interval(mins => ${STEP_UP.minutes})`;
        if (!fresh) throw new Refused('step-up', 403, 'This needs your passkey again.');
      }
      return { report: await openedByReport(tx, workItem) };
    },
    ({ report }) => [answerEvent(workItem, decision, given.hold, report, given.words)],
  );
  return { workItem, hold: given.hold, decision, report };
}
