/**
 * The triage worker: takes each signal from the inbox once and decides what it becomes.
 *
 * - A sense's signal with a fingerprint no open ticket has opens a work item with its ticket.
 * - One on an open ticket adds its evidence the first time each sense sees it; after that the inbox counts it,
 *   with no event, so the event count grows with tickets, not with the minutes a defect stays unfixed.
 * - Every report becomes events, judged by Jev: a new ticket, a repeat that joins an open one, or a work item
 *   that says it was quarantined, parked or discarded.
 * - So does every finding the planner leaves, judged the same way and trusted no more, except that it never opens a
 *   ticket: a defect is parked until a sense sees it or Martin opens one. A ticket triage opens with the same
 *   fingerprint closes it into that ticket; Martin approving it opens its ticket, by the policy's table as a sense's
 *   would be, or joins it to an open ticket that has it; his rejection closes it (`settleOne`). Nothing else opens a
 *   ticket from a finding.
 *
 * One worker decides at a time (it holds an advisory lock), so two signals with the same new fingerprint cannot
 * open two tickets. It takes nothing while the line is stopped, and no report while the gateway waits on a spend cap.
 */
import type { InboxSignal, PayloadOf, SymptomClass } from '@software-factory/events';
import { type EventWriter, nextWorkItem } from '@software-factory/store';
import type { Sql } from 'postgres';
import { INBOX } from '../../../policy/triage.ts';
import {
  approvedFinding,
  closedFinding,
  findingEvents,
  idsFor,
  type ParkedDefect,
  reportEvents,
  senseEvidence,
  senseTicket,
} from './events.ts';
import { type Judge, JudgeWaiting } from './judge.ts';
import type { Candidate } from './questions.ts';
import { judgeReport, type PageReader } from './reports.ts';
import { routeFinding, routeReport } from './routing.ts';
import { privatePath } from './scrub.ts';

/** What triage made of a signal, as the inbox records it. */
export type Outcome = 'opened' | 'evidence' | 'counted' | 'report' | 'finding';

export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface TriageOptions {
  /** As the factory's writer. */
  sql: Sql;
  events: EventWriter;
  judge: Judge;
  read: PageReader;
  log: Logger;
  now?: () => Date;
  /** Told of each signal triaged, with how long it waited in the inbox. */
  onTriaged?: (outcome: Outcome, signal: InboxSignal, waitedSeconds: number, ticketOpened: boolean) => void;
}

interface Taken {
  id: string;
  sense: string;
  signal: InboxSignal;
  attempts: number;
  received_at: Date;
}

type Ticket = { workItem: string } & Pick<PayloadOf<'ticket.opened'>, 'title' | 'category' | 'fingerprint'>;

export type Took = Outcome | 'idle' | 'stopped' | 'waiting' | 'failed';

export class Triage {
  readonly #o: Required<Omit<TriageOptions, 'onTriaged'>> & Pick<TriageOptions, 'onTriaged'>;
  /** Until when reports wait: the gateway cannot answer before then. The senses' signals need no model. */
  #reportsWaitUntil = 0;

  constructor(options: TriageOptions) {
    this.#o = { now: () => new Date(), ...options };
  }

  /** Takes one signal, if the line is running and one is waiting, and triages it. */
  async takeOne(): Promise<Took> {
    const now = this.#o.now();
    if (await lineStopped(this.#o.sql)) return 'stopped';
    const reportsWait = now.getTime() < this.#reportsWaitUntil;
    const taken = await this.#claim(reportsWait);
    if (!taken) return reportsWait ? 'waiting' : 'idle';
    const log = { signal: taken.id, sense: taken.sense, attempt: taken.attempts };
    try {
      const { outcome, workItem, ticketOpened } = await this.#triage(taken);
      await this.#o.sql`update inbox set triaged_at = ${now}, outcome = ${outcome}, work_item = ${workItem},
                        failure = null where id = ${taken.id}`;
      const waited = (now.getTime() - taken.received_at.getTime()) / 1000;
      this.#o.log.info({ ...log, outcome, workItem }, 'triaged a signal');
      this.#o.onTriaged?.(outcome, taken.signal, waited, ticketOpened);
      return outcome;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof JudgeWaiting) {
        // Not the signal's fault: it keeps its attempt, and no report is taken until the gateway can answer. The
        // senses' signals carry on, because they call no model.
        this.#reportsWaitUntil = error.until.getTime();
        await this.#o.sql`update inbox set attempts = attempts - 1, failure = ${reason}, not_before = ${error.until}
                          where id = ${taken.id}`;
        this.#o.log.warn({ ...log, until: error.until.toISOString(), reason }, 'triage is waiting for the gateway');
        return 'waiting';
      }
      const retry = new Date(now.getTime() + 2 ** taken.attempts * 15_000);
      await this.#o.sql`update inbox set failure = ${reason}, not_before = ${retry} where id = ${taken.id}`;
      const last = taken.attempts >= INBOX.attempts;
      this.#o.log.warn({ ...log, reason, last }, last ? 'a signal failed for the last time' : 'a signal failed');
      return 'failed';
    }
  }

  /**
   * Triages until aborted: woken by a new signal or a new event (the line starting again), and every half a minute
   * for signals waiting to be tried again. Only one worker runs at a time.
   */
  async run(abort: AbortSignal): Promise<void> {
    const { sql } = this.#o;
    const lock = await sql.reserve();
    try {
      await lock`select pg_advisory_lock(hashtext('triage'))`;
      let wake = Promise.withResolvers<void>();
      const nudge = () => wake.resolve();
      const listening = await Promise.all([sql.listen('inbox', nudge), sql.listen('events', nudge)]);
      abort.addEventListener('abort', nudge);
      while (!abort.aborted) {
        const settled = await this.settleOne();
        const took = await this.takeOne();
        if (!settled && (took === 'idle' || took === 'stopped' || took === 'waiting')) {
          const pause = took === 'waiting' ? Math.max(1000, this.#reportsWaitUntil - Date.now()) : 30_000;
          const timer = setTimeout(nudge, Math.min(pause, 30_000));
          await wake.promise;
          clearTimeout(timer);
          wake = Promise.withResolvers<void>();
        }
      }
      await Promise.all(listening.map((l) => l.unlisten()));
    } finally {
      await lock`select pg_advisory_unlock(hashtext('triage'))`.catch(() => {});
      lock.release();
    }
  }

  /**
   * Does what Martin answered to one defect the planner noticed, if he has approved or rejected one that is still
   * parked. Approving opens its ticket on its own work item, with the category and severity the policy gives its
   * symptom, unless an open ticket has its fingerprint, which it then joins; any other finding parked with the same
   * fingerprint joins the new ticket. Rejecting closes it. Answering in words leaves it waiting.
   */
  async settleOne(): Promise<boolean> {
    const { sql, events } = this.#o;
    const now = this.#o.now();
    if (await lineStopped(sql)) return false;
    const [row] = await sql<{ work_item: string; defect: ParkedDefect; decision: 'approved' | 'rejected' }[]>`
      select h.work_item, h.payload->'defect' as defect, a.payload->>'decision' as decision
      from events h join events a on a.work_item = h.work_item and a.type = 'hold.answered' and a.seq > h.seq
      where h.type = 'hold.started' and h.payload->>'cause' = 'finding'
        and a.payload->>'decision' in ('approved', 'rejected')
        and not exists (select 1 from events e where e.work_item = h.work_item
                        and e.type in ('work-item.closed', 'ticket.opened'))
      order by a.seq limit 1`;
    if (!row) return false;
    const { work_item: workItem, defect, decision } = row;
    const seed = `finding:${workItem}:${decision}`;
    if (decision === 'rejected') {
      await events.append(closedFinding(workItem, { rejected: true }, seed, now));
    } else {
      const same = (await openTickets(sql)).find((ticket) => sameFingerprint(ticket.fingerprint, defect));
      if (same) {
        await events.append(closedFinding(workItem, { joined: same.workItem, by: 'martin' }, seed, now));
      } else {
        const joined = (await this.#joinFindings(defect, workItem, 'martin', seed)).filter(
          (event) => event.work_item !== workItem,
        );
        await events.append([...approvedFinding(workItem, defect, now), ...joined]);
      }
    }
    this.#o.log.info({ workItem, decision }, 'settled a defect the planner noticed, as Martin answered');
    return true;
  }

  /** The events that close every parked finding a new ticket has, into that ticket. */
  async #joinFindings(
    fingerprint: PayloadOf<'ticket.opened'>['fingerprint'],
    ticket: string,
    by: 'sense' | 'report' | 'martin',
    seed: string,
  ) {
    const now = this.#o.now();
    return (await parkedFindings(this.#o.sql))
      .filter((parked) => parked.workItem !== ticket && sameFingerprint(fingerprint, parked.defect))
      .flatMap((parked) =>
        closedFinding(parked.workItem, { joined: ticket, by }, `${seed}:joined:${parked.workItem}`, now),
      );
  }

  /**
   * Holds the oldest waiting signal for a while, so another worker leaves it alone, and counts the attempt. While
   * reports wait for the gateway, it takes only the senses' signals.
   */
  async #claim(skipReports: boolean): Promise<Taken | undefined> {
    const [row] = await this.#o.sql<Taken[]>`
      update inbox set attempts = attempts + 1,
                       not_before = clock_timestamp() + make_interval(secs => ${INBOX.leaseSeconds})
      where id = (select id from inbox
                  where triaged_at is null and not_before <= clock_timestamp() and attempts < ${INBOX.attempts}
                    and (not ${skipReports} or sense not in ('report', 'planner'))
                  order by received_at limit 1 for update skip locked)
      returning id, sense, signal, attempts, received_at`;
    return row;
  }

  async #triage(taken: Taken): Promise<{ outcome: Outcome; workItem: string; ticketOpened: boolean }> {
    const { sql, events } = this.#o;
    const now = this.#o.now();
    const signal = taken.signal;

    // Its events may have been appended before a crash stopped the inbox hearing of it.
    const [done] = await sql<{ work_item: string; type: string }[]>`
      select work_item, type from events where id = ${idsFor(taken.id)()}`;
    if (done) {
      const outcome = judged(signal)
        ? signal.sense === 'planner'
          ? 'finding'
          : 'report'
        : done.type === 'work-item.opened'
          ? 'opened'
          : 'evidence';
      // Counted once already, if at all: the time it took is not this attempt's.
      return { outcome, workItem: done.work_item, ticketOpened: false };
    }

    const tickets = await openTickets(sql);
    if (judged(signal)) {
      const finding = signal.sense === 'planner';
      const text = signal.report?.text;
      // The inbox refuses a report without its text; one that got in some other way is nothing to judge.
      if (!text) throw new Error(`A ${finding ? 'finding' : 'report'} reached triage without its text`);
      // The visitor may have typed the path, so anything private in it goes before anything is matched or asked.
      const page = privatePath(signal.report?.page ?? signal.route);
      const route = privatePath(signal.route);
      // A planner's finding is about something beyond the ticket it was planning, so it never joins that one.
      const others = tickets.filter((ticket) => ticket.workItem !== signal.planning);
      const candidates = others.filter((ticket) => onPage(ticket, route, page)).slice(0, 10);
      const decision = await judgeReport(
        { page, text, route },
        candidates.map(candidateOf),
        this.#o.judge,
        this.#o.read,
        finding ? routeFinding : routeReport,
      );
      // One fingerprint, one ticket: a new ticket that matches an open one joins it instead, as does a defect the
      // planner noticed that an open ticket already has.
      const { routed } = decision;
      const defect = routed.route === 'ticket' || (routed.route === 'park' && routed.defect !== undefined);
      const fingerprint =
        routed.route === 'park' && routed.defect ? { route, class: routed.defect.symptom } : decision.fingerprint;
      const same = fingerprint && others.find((ticket) => sameFingerprint(ticket.fingerprint, fingerprint));
      if (defect && same) {
        decision.routed = { route: 'repeat', joined: same.workItem };
        const first = decision.judgements[0];
        if (first) decision.judgements[0] = { ...first, route: 'repeat', joined: same.workItem };
      }
      const workItem = decision.routed.route === 'repeat' ? decision.routed.joined : await nextWorkItem(sql);
      if (finding) {
        await events.append(findingEvents(signal, taken.id, workItem, decision, now));
        return { outcome: 'finding', workItem, ticketOpened: false };
      }
      const opened = decision.routed.route === 'ticket' && decision.fingerprint;
      const joined = opened ? await this.#joinFindings(opened, workItem, 'report', taken.id) : [];
      await events.append([...reportEvents(signal, taken.id, workItem, decision, now), ...joined]);
      return { outcome: 'report', workItem, ticketOpened: decision.routed.route === 'ticket' };
    }

    const fingerprint = { route: signal.route, class: signal.symptom as SymptomClass };
    const ticket = tickets.find((open) => sameFingerprint(open.fingerprint, fingerprint));
    if (!ticket) {
      const workItem = await nextWorkItem(sql);
      const joined = await this.#joinFindings(fingerprint, workItem, 'sense', taken.id);
      await events.append([...senseTicket(signal, taken.id, workItem, now), ...joined]);
      return { outcome: 'opened', workItem, ticketOpened: true };
    }
    const [seen] = await sql`select 1 from events where work_item = ${ticket.workItem}
                             and type = 'signal.received' and payload->>'sense' = ${signal.sense} limit 1`;
    if (seen) return { outcome: 'counted', workItem: ticket.workItem, ticketOpened: false };
    await events.append(senseEvidence(signal, taken.id, ticket.workItem, now));
    return { outcome: 'evidence', workItem: ticket.workItem, ticketOpened: false };
  }
}

/** A defect the planner noticed, parked for a sense or Martin: held, with no ticket and not closed. */
interface Parked {
  workItem: string;
  defect: ParkedDefect;
}

/** Every defect the planner noticed that waits for a sense or Martin. */
async function parkedFindings(sql: Sql): Promise<Parked[]> {
  const rows = await sql<{ work_item: string; defect: ParkedDefect }[]>`
    select h.work_item, h.payload->'defect' as defect from events h
    where h.type = 'hold.started' and h.payload->>'cause' = 'finding'
      and not exists (select 1 from events e where e.work_item = h.work_item
                      and e.type in ('work-item.closed', 'ticket.opened'))
    order by h.seq`;
  return rows.map((row) => ({ workItem: row.work_item, defect: row.defect }));
}

/** Whether a signal's words are for Jev to judge: a visitor's report, or a planner's finding. */
const judged = (signal: InboxSignal) => signal.sense === 'report' || signal.sense === 'planner';

/** Whether the line is stopped: the last of `line.started` and `line.stopped` decides. */
export async function lineStopped(sql: Sql): Promise<boolean> {
  const [last] = await sql<{ type: string }[]>`
    select type from events where type in ('line.started', 'line.stopped') order by seq desc limit 1`;
  return last?.type === 'line.stopped';
}

/** Tickets whose work item has not closed. Tickets close only when a fix is verified (milestone 6). */
export async function openTickets(sql: Sql): Promise<Ticket[]> {
  const rows = await sql<{ work_item: string; payload: PayloadOf<'ticket.opened'> }[]>`
    select t.work_item, t.payload from events t
    where t.type = 'ticket.opened'
      and not exists (select 1 from events c where c.work_item = t.work_item and c.type = 'work-item.closed')
    order by t.seq desc`;
  return rows.map(({ work_item, payload }) => ({
    workItem: work_item,
    title: payload.title,
    category: payload.category,
    fingerprint: payload.fingerprint,
  }));
}

type Fingerprint = PayloadOf<'ticket.opened'>['fingerprint'];

/** The same problem: the same class on the same route, or on every route; or the same passage of the same page. */
export function sameFingerprint(open: Fingerprint, found: Fingerprint): boolean {
  if ('class' in open && 'class' in found) {
    return open.class === found.class && (open.route === found.route || open.route === '*');
  }
  if ('page' in open && 'page' in found) return open.page === found.page && open.text === found.text;
  return false;
}

/** Whether a report sent from a page could be about this ticket. */
const onPage = (ticket: Ticket, route: string, page: string) =>
  'class' in ticket.fingerprint
    ? ticket.fingerprint.route === route || ticket.fingerprint.route === '*'
    : ticket.fingerprint.page === page;

const candidateOf = (ticket: Ticket): Candidate => ({
  workItem: ticket.workItem,
  title: ticket.title,
  category: ticket.category,
  symptom: 'class' in ticket.fingerprint ? ticket.fingerprint.class : undefined,
});
