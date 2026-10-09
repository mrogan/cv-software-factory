import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InboxSignal, NewEvent, PayloadOf, Screenshot } from '@software-factory/events';
import { DiskArtifacts, EventWriter, sendSignal } from '@software-factory/store';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { INBOX } from '../../../../policy/triage.ts';
import { type Database, freshDatabase } from '../../../store/test/database.ts';
import { idsFor, senseTicket } from '../../src/events.ts';
import { type Answer, type Judge, JudgeWaiting } from '../../src/judge.ts';
import { Triage, type TriageOptions } from '../../src/worker.ts';

let database: Database;
let writer: Sql;
const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
let events: EventWriter;
const quiet = { info: () => {}, warn: () => {} };
const at = '2026-10-04T09:00:00.000Z';

beforeAll(async () => {
  database = await freshDatabase('triage');
  writer = database.writer;
  events = new EventWriter(writer, { kind: 'real', artifacts });
});
afterAll(() => database?.end());

// Each test starts with an empty inbox, no open tickets and no parked findings: earlier tests' are closed by hand.
beforeEach(async () => {
  await database.owner`update inbox set triaged_at = now(), outcome = 'counted' where triaged_at is null`;
  const open = await writer<{ work_item: string }[]>`
    select distinct work_item from events
    where (type = 'ticket.opened' or (type = 'hold.started' and payload->>'cause' = 'finding'))
      and work_item not in (select work_item from events where type = 'work-item.closed')`;
  for (const { work_item } of open) await events.append(closed(work_item));
});

function closed(item: string): NewEvent<'work-item.closed'> {
  return {
    id: crypto.randomUUID(),
    ts: at,
    work_item: item,
    type: 'work-item.closed',
    version: 1,
    actor: 'factory',
    summary: 'Closed for the next test',
    payload: { outcome: 'no-change', reason: 'The next test starts with no open tickets' },
    artifacts: [],
  } as NewEvent<'work-item.closed'>;
}

const found = (overrides: Partial<InboxSignal> = {}): InboxSignal => ({
  sense: 'crawler',
  check: 'links lead somewhere',
  route: '/about',
  version: 'c02efd8',
  symptom: 'broken-link',
  observedAt: at,
  artifacts: [],
  ...overrides,
});

const choice = (label: string, p = 0.9): Answer => ({
  type: 'choice',
  choice: label,
  confidence: p,
  probabilities: { [label]: p },
});

/** A Jev that calls every report a functional problem, a repeat of the first open ticket offered if any. */
const jev: Judge = async (request) => ({
  model: request.model,
  answers: {
    category: choice('functional'),
    symptom: choice('wrong-result'),
    severity: { type: 'score', score: 2.8, confidence: 0.9, probabilities: { 3: 0.8 } },
    injection: { type: 'noul', noul: 0.01 },
    ...(request.questions.repeat && { repeat: choice('t1', 0.85) }),
  },
  costUsd: 0.00002,
  durationMs: 80,
  cassette: 'c'.repeat(64),
});

const triage = (options: Partial<TriageOptions> = {}) =>
  new Triage({ sql: writer, events, judge: jev, read: async () => null, log: quiet, ...options });

const types = (item: string) =>
  writer<{ type: string }[]>`select type from events where work_item = ${item} order by seq`.then((rows) =>
    rows.map((r) => r.type),
  );

describe('triage', () => {
  it('opens a ticket for a new fingerprint, adds each other sense’s evidence once, and counts the rest', async () => {
    await sendSignal(writer, found());
    expect(await triage().takeOne()).toBe('opened');
    const [{ work_item: item = '' } = {}] = await writer<{ work_item: string }[]>`
      select work_item from inbox where outcome = 'opened' order by received_at desc limit 1`;
    expect(await types(item)).toEqual(['work-item.opened', 'signal.received', 'ticket.opened', 'work-item.summarised']);

    await sendSignal(writer, found());
    await sendSignal(writer, found({ sense: 'probe', check: 'every link on the page leads somewhere' }));
    await sendSignal(writer, found({ sense: 'probe', check: 'every link on the page leads somewhere' }));
    expect([await triage().takeOne(), await triage().takeOne(), await triage().takeOne()]).toEqual([
      'counted',
      'evidence',
      'counted',
    ]);
    expect((await types(item)).filter((t) => t === 'signal.received')).toHaveLength(2);
    expect(await triage().takeOne()).toBe('idle');
  });

  it('numbers work items from the store, and counts a route’s signal on a ticket for every page', async () => {
    await sendSignal(writer, found({ route: '*', symptom: 'missing-header', check: 'security headers' }));
    await triage().takeOne();
    await sendSignal(writer, found({ route: '/contact', symptom: 'missing-header', check: 'security headers' }));
    expect(await triage().takeOne()).toBe('counted');
    const items = await writer<
      { work_item: string }[]
    >`select distinct work_item from inbox where work_item is not null`;
    for (const { work_item } of items) expect(Number(work_item)).toBeGreaterThanOrEqual(1000);
  });

  it('turns a report into a ticket, and a second report on the same page into a repeat of it', async () => {
    const report = found({
      sense: 'report',
      check: 'report widget',
      symptom: undefined,
      report: { page: '/about', text: 'The year on the about page is wrong' },
    });
    const opened: boolean[] = [];
    const counting = triage({ onTriaged: (_outcome, _signal, _waited, ticket) => opened.push(ticket) });
    await sendSignal(writer, report);
    expect(await counting.takeOne()).toBe('report');
    await sendSignal(writer, report);
    expect(await counting.takeOne()).toBe('report');
    // Only the first opened a ticket, so only it counts towards the time from signal to ticket.
    expect(opened).toEqual([true, false]);
    const [first, second] = await writer<{ work_item: string }[]>`
      select work_item from inbox where outcome = 'report' order by received_at desc limit 2`;
    expect(first?.work_item).toBe(second?.work_item);
    expect(await types(first?.work_item ?? '')).toEqual([
      'work-item.opened',
      'signal.received',
      'judgement.made',
      'ticket.opened',
      'work-item.summarised',
      'signal.received',
      'judgement.made',
    ]);
  });

  it('never opens a ticket on the planner’s word: a defect it noticed waits for a sense or Martin', async () => {
    const finding = found({
      sense: 'planner',
      check: 'planning ticket #1001',
      route: '/contact',
      symptom: undefined,
      report: { page: '/contact', text: 'The form says it sends at once, and waits a minute' },
      planning: '1001',
    });
    const opened: boolean[] = [];
    await sendSignal(writer, finding);
    expect(await triage({ onTriaged: (_o, _s, _w, ticket) => opened.push(ticket) }).takeOne()).toBe('finding');
    expect(opened).toEqual([false]);
    const [{ work_item: item = '' } = {}] = await writer<{ work_item: string }[]>`
      select work_item from inbox where outcome = 'finding' order by received_at desc limit 1`;
    expect(await types(item)).toEqual([
      'work-item.opened',
      'signal.received',
      'judgement.made',
      'hold.started',
      'work-item.summarised',
    ]);
    const [hold] = await writer<{ payload: { cause: string }; public: { payload: { report: object } } }[]>`
      select e.payload, s.public from events e, events s
      where e.work_item = ${item} and e.type = 'hold.started' and s.work_item = ${item} and s.type = 'signal.received'`;
    expect(hold?.payload.cause).toBe('finding');
    // Its words are as private as a visitor's.
    expect(hold?.public.payload.report).toEqual({ page: '/contact' });
  });

  it('parks the planner’s suggestion for Martin, and joins a defect it noticed to the open ticket that has it', async () => {
    const finding = (route: string, planning = '1') =>
      found({
        sense: 'planner',
        check: `planning ticket #${planning}`,
        route,
        symptom: undefined,
        report: { page: route, text: 'The page could say more' },
        planning,
      });
    const suggests: Judge = async (request) => {
      const judged = await jev(request);
      return { ...judged, answers: { ...judged.answers, category: choice('suggestion') } };
    };
    await sendSignal(writer, finding('/delivery'));
    expect(await triage({ judge: suggests }).takeOne()).toBe('finding');
    const [held] = await writer<{ payload: { cause: string } }[]>`
      select payload from events where type = 'hold.started' order by seq desc limit 1`;
    expect(held?.payload.cause).toBe('suggestion');

    await sendSignal(writer, found());
    expect(await triage().takeOne()).toBe('opened');
    await sendSignal(writer, finding('/about'));
    expect(await triage().takeOne()).toBe('finding');
    const [ticket, joined] = await writer<{ work_item: string }[]>`
      select work_item from inbox where outcome in ('opened', 'finding') order by received_at desc limit 2`.then(
      (rows) => rows.reverse(),
    );
    expect(joined?.work_item).toBe(ticket?.work_item);
    expect((await types(ticket?.work_item ?? '')).slice(-2)).toEqual(['signal.received', 'judgement.made']);

    // Never into the ticket it was planning: what it noticed there is beyond that ticket, so it waits on its own.
    const planned = ticket?.work_item ?? '';
    await sendSignal(writer, finding('/about', planned));
    expect(await triage().takeOne()).toBe('finding');
    const [own] = await writer<{ work_item: string }[]>`
      select work_item from inbox where outcome = 'finding' order by received_at desc limit 1`;
    expect(own?.work_item).not.toBe(planned);
    expect(await types(own?.work_item ?? '')).toContain('hold.started');
    const [offered] = await writer<{ payload: { state: { candidates?: unknown[] } } }[]>`
      select payload from events where work_item = ${own?.work_item ?? ''} and type = 'judgement.made'`;
    expect(offered?.payload.state.candidates).toBeUndefined();
  });

  describe('a defect the planner noticed, parked', () => {
    const park = async (route: string, planning = '1') => {
      await sendSignal(
        writer,
        found({
          sense: 'planner',
          check: `planning ticket #${planning}`,
          route,
          symptom: undefined,
          report: { page: route, text: 'The total is wrong' },
          planning,
        }),
      );
      expect(await triage().takeOne()).toBe('finding');
      const [row] = await writer<{ work_item: string }[]>`
        select work_item from inbox where outcome = 'finding' order by received_at desc limit 1`;
      return row?.work_item ?? '';
    };
    const answer = (item: string, decision: 'approved' | 'rejected' | 'answered') =>
      events.append({
        id: crypto.randomUUID(),
        ts: at,
        work_item: item,
        type: 'hold.answered',
        version: 1,
        actor: 'martin',
        summary: `Martin ${decision} it`,
        payload: { decision },
        artifacts: [],
      } as NewEvent<'hold.answered'>);
    const closing = async (item: string) =>
      (
        await writer<{ payload: { outcome: string; reason: string } }[]>`
          select payload from events where work_item = ${item} and type = 'work-item.closed'`
      )[0]?.payload;

    it('fingerprints wrong words by their passage, as a report’s ticket is, and closes into that ticket', async () => {
      const bytes = new TextEncoder().encode('a screenshot of /about');
      const shot: Screenshot = {
        kind: 'screenshot',
        hash: await artifacts.put(bytes),
        type: 'image/png',
        size: bytes.length,
        route: '/about',
        version: 'c02efd8',
        width: 1280,
        height: 800,
        boxes: [],
      };
      const passage = 'Founded in 1066, the shop has sold doorstops for a century.';
      const read = async () => ({ screenshot: shot, passages: ['Doorstops and more.', passage] });
      // Jev reads both as wrong words, and picks the same passage of the page.
      const words: Judge = async (request) => {
        if (request.questionSet === 'passage/v1') {
          return { ...(await jev(request)), answers: { passage: choice('p2') } };
        }
        const judged = await jev(request);
        return { ...judged, answers: { ...judged.answers, category: choice('content') } };
      };
      const about = (sense: 'planner' | 'report') =>
        found({
          sense,
          check: sense === 'planner' ? 'planning ticket #1' : 'report widget',
          symptom: undefined,
          report: { page: '/about', text: 'The year the shop was founded is wrong' },
          ...(sense === 'planner' && { planning: '1' }),
        });
      await sendSignal(writer, about('planner'));
      expect(await triage({ judge: words, read }).takeOne()).toBe('finding');
      const [{ work_item: item = '' } = {}] = await writer<{ work_item: string }[]>`
        select work_item from inbox where outcome = 'finding' order by received_at desc limit 1`;
      const [hold] = await writer<{ payload: PayloadOf<'hold.started'> }[]>`
        select payload from events where work_item = ${item} and type = 'hold.started'`;
      expect(hold?.payload.defect).toEqual({ fingerprint: { page: '/about', text: passage }, symptom: 'wrong-result' });

      await sendSignal(writer, about('report'));
      expect(await triage({ judge: words, read }).takeOne()).toBe('report');
      const [{ work_item: ticket = '' } = {}] = await writer<{ work_item: string }[]>`
        select work_item from inbox where outcome = 'report' order by received_at desc limit 1`;
      expect(await closing(item)).toEqual({ outcome: 'no-change', reason: `A visitor reported it: ticket #${ticket}` });
    });

    it('names its fingerprint on its hold, and closes into the ticket a sense opens with it', async () => {
      const item = await park('/basket');
      const [hold] = await writer<{ payload: PayloadOf<'hold.started'> }[]>`
        select payload from events where work_item = ${item} and type = 'hold.started'`;
      expect(hold?.payload.defect).toEqual({
        fingerprint: { route: '/basket', class: 'wrong-result' },
        symptom: 'wrong-result',
      });
      await sendSignal(writer, found({ route: '/basket', symptom: 'wrong-result', check: 'the basket adds up' }));
      expect(await triage().takeOne()).toBe('opened');
      const [{ work_item: ticket = '' } = {}] = await writer<{ work_item: string }[]>`
        select work_item from inbox where outcome = 'opened' order by received_at desc limit 1`;
      expect(await closing(item)).toEqual({ outcome: 'no-change', reason: `A sense saw it: ticket #${ticket}` });
      expect(await triage().settleOne()).toBe(false);
    });

    it('waits while Martin only answers, and opens its ticket by the policy’s table when he approves', async () => {
      const item = await park('/checkout');
      const twin = await park('/checkout');
      expect(await triage().settleOne()).toBe(false);
      await answer(item, 'answered');
      expect(await triage().settleOne()).toBe(false);
      await answer(item, 'approved');
      expect(await triage().settleOne()).toBe(true);
      const [opened] = await writer<{ actor: string; payload: PayloadOf<'ticket.opened'> }[]>`
        select actor, payload from events where work_item = ${item} and type = 'ticket.opened'`;
      // Its category and severity are the policy's for the symptom, as a sense's ticket's are.
      expect(opened?.payload).toEqual({
        title: 'A wrong result on /checkout',
        category: 'functional',
        severity: 'broken',
        fingerprint: { route: '/checkout', class: 'wrong-result' },
        traces: [],
      });
      // One fingerprint, one ticket: the same defect parked again joins it.
      expect(await closing(twin)).toEqual({ outcome: 'no-change', reason: `Ticket #${item} already has it` });
      expect(await triage().settleOne()).toBe(false);
    });

    it('joins a ticket on every page, then one a sense already has, and closes when he rejects it', async () => {
      const first = await park('/gift-cards');
      const second = await park('/delivery');
      await sendSignal(writer, found({ route: '*', symptom: 'wrong-result', check: 'prices add up' }));
      expect(await triage().takeOne()).toBe('opened');
      const [{ work_item: ticket = '' } = {}] = await writer<{ work_item: string }[]>`
        select work_item from inbox where outcome = 'opened' order by received_at desc limit 1`;
      // A sense's ticket on every page closes every finding parked with its symptom: no longer anything to answer.
      for (const item of [first, second]) {
        expect(await closing(item)).toEqual({ outcome: 'no-change', reason: `A sense saw it: ticket #${ticket}` });
      }
      await expect(answer(second, 'approved')).rejects.toThrow('is closed');
      // One noticed while the sense's ticket is open joins it at once, as a repeat, and is never parked.
      expect(await park('/wishlist')).toBe(ticket);

      await events.append(closed(ticket));
      const late = await park('/wishlist');
      await answer(late, 'rejected');
      expect(await triage().settleOne()).toBe(true);
      expect(await closing(late)).toEqual({
        outcome: 'discarded',
        reason: 'Martin rejected the defect the planner noticed',
      });
    });

    it('holds one with the fingerprint of the ticket being planned, saying so, until a sense’s ticket can take it', async () => {
      await sendSignal(writer, found({ route: '/basket', symptom: 'wrong-result', check: 'the basket adds up' }));
      expect(await triage().takeOne()).toBe('opened');
      const [{ work_item: planned = '' } = {}] = await writer<{ work_item: string }[]>`
        select work_item from inbox where outcome = 'opened' order by received_at desc limit 1`;
      const item = await park('/basket', planned);
      expect(item).not.toBe(planned);
      const [hold] = await writer<{ payload: PayloadOf<'hold.started'> }[]>`
        select payload from events where work_item = ${item} and type = 'hold.started'`;
      expect(hold?.payload.reason).toContain(`A sense’s ticket can take it once #${planned} closes`);
      // The planned ticket's fix is verified and it closes; the defect is still there, and a sense opens its ticket.
      await events.append(closed(planned));
      await sendSignal(writer, found({ route: '/basket', symptom: 'wrong-result', check: 'the basket adds up' }));
      expect(await triage().takeOne()).toBe('opened');
      expect((await closing(item))?.reason).toMatch(/^A sense saw it: ticket #/);
    });

    it('leaves an answer it cannot act on for the next event, and after as many tries as a signal, alone', async () => {
      const item = await park('/gift-cards');
      await answer(item, 'approved');
      let tried = 0;
      const broken = {
        append: async () => {
          tried += 1;
          throw new Error('The store is down');
        },
      } as unknown as EventWriter;
      const failing = triage({ events: broken });
      for (let i = 0; i <= INBOX.attempts; i++) expect(await failing.settleOne()).toBe(false);
      expect(tried).toBe(INBOX.attempts);
      // It was not acted on, and this worker leaves it now; a fresh one, with the store back, does as he said.
      expect(await writer`select 1 from events where work_item = ${item} and type = 'ticket.opened'`).toHaveLength(0);
      expect(await triage().settleOne()).toBe(true);
    });

    it('joins the open ticket that has it when he approves it, if one opened without closing it', async () => {
      const item = await park('/gift-wrap');
      await answer(item, 'approved');
      // A ticket opened by hand, which no triage rule closed the finding into.
      const other = '999';
      await events.append([
        {
          ...closed(other),
          type: 'work-item.opened',
          version: 2,
          payload: { kind: 'defect-fix', title: 'Gift wrap', sample: false },
        },
        {
          ...closed(other),
          type: 'ticket.opened',
          payload: {
            title: 'A wrong result on /gift-wrap',
            category: 'functional',
            severity: 'broken',
            fingerprint: { route: '/gift-wrap', class: 'wrong-result' },
            traces: [],
          },
        },
      ] as NewEvent[]);
      expect(await triage().settleOne()).toBe(true);
      expect(await closing(item)).toEqual({ outcome: 'no-change', reason: 'Ticket #999 already has it' });
      expect(await writer`select 1 from events where work_item = ${item} and type = 'ticket.opened'`).toHaveLength(0);
    });
  });

  it('takes nothing while the line is stopped, and carries on when it starts again', async () => {
    const line = (type: 'line.stopped' | 'line.started', payload: object) =>
      events.append({
        id: crypto.randomUUID(),
        ts: at,
        work_item: null,
        type,
        version: 1,
        actor: 'martin',
        summary: type === 'line.stopped' ? 'Martin stopped the line' : 'Martin started the line',
        payload,
        artifacts: [],
      } as NewEvent);
    await sendSignal(writer, found({ route: '/stopped' }));
    await line('line.stopped', { reason: 'A test' });
    expect(await triage().takeOne()).toBe('stopped');
    await line('line.started', { autonomy: 'supervised' });
    expect(await triage().takeOne()).toBe('opened');
  });

  it('settles again after an event that arrives while it settles, so no answer waits for the next one', async () => {
    let calls = 0;
    const first = Promise.withResolvers<boolean>();
    const again = Promise.withResolvers<void>();
    class Watched extends Triage {
      override async settleOne(): Promise<boolean> {
        calls += 1;
        if (calls === 1) return first.promise;
        again.resolve();
        return false;
      }
    }
    const abort = new AbortController();
    const running = new Watched({ sql: writer, events, judge: jev, read: async () => null, log: quiet }).run(
      abort.signal,
    );
    await expect.poll(() => calls).toBe(1);
    // An event, such as Martin's answer, is appended while the first settling is still reading.
    await events.append({
      id: crypto.randomUUID(),
      ts: at,
      work_item: null,
      type: 'line.started',
      version: 1,
      actor: 'martin',
      summary: 'Martin started the line',
      payload: { autonomy: 'supervised' },
      artifacts: [],
    } as NewEvent);
    await new Promise((heard) => setTimeout(heard, 300));
    first.resolve(false);
    const late = new Promise<string>((resolve) => setTimeout(() => resolve('not settled again'), 3000));
    expect(await Promise.race([again.promise.then(() => 'settled again'), late])).toBe('settled again');
    abort.abort();
    await running;
  });

  it('waits for the gateway without using up a report’s attempts, saying why', async () => {
    const until = new Date(Date.now() + 60_000);
    const waiting: Judge = async () => {
      throw new JudgeWaiting('No cassette for this report, and the gateway has no key', until);
    };
    const id = await sendSignal(
      writer,
      found({ sense: 'report', symptom: undefined, report: { page: '/', text: 'Nothing loads' } }),
    );
    const worker = triage({ judge: waiting });
    expect(await worker.takeOne()).toBe('waiting');
    expect(await worker.takeOne()).toBe('waiting');
    const [row] = await writer`select attempts, failure, triaged_at from inbox where id = ${id}`;
    expect(row).toMatchObject({ attempts: 0, failure: 'No cassette for this report, and the gateway has no key' });
    expect(row?.triaged_at).toBeNull();
  });

  it('keeps opening the senses’ tickets while reports wait for the gateway', async () => {
    const until = new Date(Date.now() + 60_000);
    const worker = triage({
      judge: async () => {
        throw new JudgeWaiting('The day spend cap is reached', until);
      },
    });
    await sendSignal(writer, found({ sense: 'report', symptom: undefined, report: { page: '/', text: 'Broken' } }));
    expect(await worker.takeOne()).toBe('waiting');
    await sendSignal(writer, found({ route: '/during-a-cap' }));
    expect(await worker.takeOne()).toBe('opened');
    expect(await worker.takeOne()).toBe('waiting');
  });

  it('leaves a signal that keeps failing in the inbox with its reason', async () => {
    const id = await sendSignal(
      writer,
      found({ sense: 'report', symptom: undefined, report: { page: '/', text: 'Broken' } }),
    );
    const failing = triage({
      judge: async () => {
        throw new Error('The gateway answered 502');
      },
    });
    expect(await failing.takeOne()).toBe('failed');
    const [row] = await writer`select attempts, failure from inbox where id = ${id}`;
    expect(row).toEqual({ attempts: 1, failure: 'The gateway answered 502' });
    await database.owner`update inbox set attempts = 5, not_before = now() where id = ${id}`;
    expect(await triage().takeOne()).toBe('idle');
  });

  it('records what it made of a signal whose events were appended before a crash, appending nothing again', async () => {
    const signal = found({ route: '/crashed' });
    const id = await sendSignal(writer, signal);
    await events.append(senseTicket(signal, id, '1999', new Date(at)));
    expect(await triage().takeOne()).toBe('opened');
    const [row] = await writer`select work_item from inbox where id = ${id}`;
    expect(row?.work_item).toBe('1999');
    expect(await writer`select count(*)::int as n from events where id = ${idsFor(id)()}`).toEqual([{ n: 1 }]);
  });
});
