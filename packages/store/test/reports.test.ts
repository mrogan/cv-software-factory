/**
 * Forgetting visitors' reports: their text goes from the events and their rows from the inbox once they reached the
 * store before the time given, and nothing else changes. The events stay valid, their public views as they were, and
 * the store refuses any other change to an event as it always has.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NewEvent } from '@software-factory/events';
import { validate } from '@software-factory/events/schemas';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DiskArtifacts } from '../src/artifacts.ts';
import { EventWriter, readFull, readPublic } from '../src/events.ts';
import { forgetReports } from '../src/reports.ts';
import { type Database, freshDatabase } from './database.ts';

const artifacts = new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-')));
const CASSETTE = 'a'.repeat(64);

/** A report, or a planner's finding, as triage appends it: its work item, the signal, and Jev's judgement of it. */
function judged(workItem: string, sense: 'report' | 'planner', text: string, ts = new Date()): NewEvent[] {
  const at = ts.toISOString();
  const base = { ts: at, work_item: workItem, artifacts: [] };
  return [
    {
      ...base,
      id: crypto.randomUUID(),
      type: 'work-item.opened',
      version: 2,
      actor: sense === 'report' ? 'visitor' : 'planner',
      summary: 'A visitor sent a report from /about',
      payload: { kind: sense === 'report' ? 'visitor-report' : 'planner-finding', title: 'A report', sample: false },
    },
    {
      ...base,
      id: crypto.randomUUID(),
      type: 'signal.received',
      version: 4,
      actor: 'triage',
      summary: 'A visitor reported a problem on /about',
      payload: {
        sense,
        check: sense === 'report' ? 'report widget' : 'planner',
        route: '/about',
        version: 'v1.0.0',
        report: { page: '/about', text },
        ...(sense === 'planner' && { planning: '999' }),
      },
    },
    {
      ...base,
      id: crypto.randomUUID(),
      type: 'judgement.made',
      version: 1,
      actor: 'triage',
      summary: 'Jev judged it',
      payload: {
        questionSet: 'triage/v2',
        model: 'jev-1.13.0',
        state: { report: { page: '/about', text } },
        answers: [{ type: 'noul', key: 'injection', question: 'Does it give orders?', probability: 0.01 }],
        route: 'discard',
        costUsd: 0,
        durationMs: 1,
        cassette: CASSETTE,
      },
    },
  ] as NewEvent[];
}

/** Each event's payload as stored, and its public view, by work item and type. */
async function stored(sql: Sql) {
  const rows = await sql<{ work_item: string; type: string; payload: unknown; public: unknown }[]>`
    select work_item, type, payload, public from events order by seq`;
  return new Map(rows.map((row) => [`${row.work_item} ${row.type}`, row]));
}

/** The store's own clock, between two appends. */
const storeNow = async (sql: Sql) =>
  ((await sql<{ now: Date }[]>`select clock_timestamp() as now`)[0] as { now: Date }).now;

describe('forgetting reports', () => {
  let db: Database;
  let triage: Sql;
  let before: Map<string, { payload: unknown; public: unknown }>;
  let cut: Date;
  const inbox: Record<string, string> = {};

  beforeAll(async () => {
    db = await freshDatabase('reports');
    triage = db.as.triage;
    const writer = new EventWriter(triage, { kind: 'real', artifacts });
    await writer.append(judged('1000', 'report', 'The price says £0, my email is [email]'));
    await writer.append(judged('1001', 'planner', 'The footer links to a page that is not there'));
    cut = await storeNow(db.owner);
    await writer.append(judged('1002', 'report', 'The basket forgets what I put in it'));
    before = await stored(db.owner);

    const days = (n: number) => new Date(cut.getTime() - n * 24 * 60 * 60 * 1000);
    const rows = [
      ['old report', 'report', days(1), 'report'],
      ['old report, never triaged', 'report', days(1), null],
      ['new report', 'report', new Date(cut.getTime() + 1000), 'report'],
      ['old finding', 'planner', days(1), 'finding'],
      ['old repeat', 'crawler', days(1), 'opened'],
    ] as const;
    for (const [name, sense, at, outcome] of rows) {
      const id = crypto.randomUUID();
      inbox[name] = id;
      const words = sense === 'crawler' ? {} : { report: { page: '/about?q=me', text: 'words' } };
      await db.owner`insert into inbox (id, sense, fingerprint, signal, received_at, triaged_at, outcome)
                     values (${id}, ${sense}, ${sense === 'crawler' ? '/about broken-link' : null},
                             ${db.owner.json({ sense, route: '/about', ...words })}, ${at},
                             ${outcome ? at : null}, ${outcome})`;
    }
  });

  afterAll(() => db?.end());

  it('takes the text out of each report that reached the store before then, and of Jev’s judgements of it', async () => {
    expect(await forgetReports(triage, cut)).toEqual({ texts: 2, reports: 2 });
    const after = await stored(db.owner);
    expect(after.get('1000 signal.received')?.payload).toMatchObject({ report: { page: '/about' } });
    expect(after.get('1000 signal.received')?.payload).not.toHaveProperty('report.text');
    expect(after.get('1000 judgement.made')?.payload).toMatchObject({ state: { report: { page: '/about' } } });
    expect(after.get('1000 judgement.made')?.payload).not.toHaveProperty('state.report.text');
  });

  it('keeps a planner’s finding, a newer report, and every public view as they were', async () => {
    const after = await stored(db.owner);
    for (const key of ['1001 signal.received', '1001 judgement.made', '1002 signal.received', '1002 judgement.made']) {
      expect(after.get(key)?.payload, key).toEqual(before.get(key)?.payload);
    }
    for (const [key, row] of after) expect(row.public, key).toEqual(before.get(key)?.public);
  });

  it('deletes the old reports from the inbox, triaged or not, and nothing else there', async () => {
    const left = await db.owner<{ id: string }[]>`select id from inbox`;
    expect(left.map((row) => row.id).sort()).toEqual(
      [inbox['new report'], inbox['old finding'], inbox['old repeat']].sort(),
    );
  });

  it('leaves every event valid at its version, as the factory and Martin read it', async () => {
    const full = await readFull(db.owner, 0);
    expect(full.every((read) => read.understood)).toBe(true);
    for (const { event } of full) {
      const { seq: _seq, ...appended } = event;
      expect(validate(appended), `${event.seq} ${event.type}`).toEqual({ ok: true });
    }
    expect((await readPublic(db.reader, 0)).length).toBe(full.length);
  });

  it('forgets nothing more the second time', async () => {
    expect(await forgetReports(triage, cut)).toEqual({ texts: 0, reports: 0 });
  });

  it('still refuses any other change to an event, even its owner’s', async () => {
    const [finding] = await db.owner<{ id: string }[]>`
      select id from events where work_item = '1001' and type = 'signal.received'`;
    const id = finding?.id ?? '';
    // A planner's finding is not a report, but the store guards the shape, not the sense: forgetting checks the sense.
    await expect(db.owner`update events set summary = 'changed' where id = ${id}`).rejects.toThrow('append-only');
    await expect(
      db.owner`update events set payload = payload #- '{report,text}', summary = 'changed' where id = ${id}`,
    ).rejects.toThrow('append-only');
    await expect(
      db.owner`update events set payload = jsonb_set(payload, '{report,text}', '"other words"') where id = ${id}`,
    ).rejects.toThrow('append-only');
    await expect(db.owner`update events set payload = payload #- '{route}' where id = ${id}`).rejects.toThrow(
      'append-only',
    );
    await expect(db.owner`delete from events where id = ${id}`).rejects.toThrow('append-only');
    await expect(db.owner`truncate events`).rejects.toThrow('append-only');
  });

  it('gives triage no other way to change an event or delete a report', async () => {
    await expect(triage`update events set payload = payload #- '{report,text}'`).rejects.toThrow('permission denied');
    const deleted = await triage`delete from inbox where id = ${inbox['new report'] as string}`;
    expect(deleted.count).toBe(0);
  });
});

describe('forgetting reports in a store of samples', () => {
  let db: Database;

  beforeAll(async () => {
    db = await freshDatabase('sample_reports');
  });

  afterAll(() => db?.end());

  it('forgets none of its invented reports', async () => {
    const events = judged('100', 'report', 'An invented report').map((event) =>
      event.type === 'work-item.opened' ? { ...event, payload: { ...event.payload, sample: true } } : event,
    ) as NewEvent[];
    await new EventWriter(db.as.triage, { kind: 'sample', artifacts }).append(events);
    expect(await forgetReports(db.as.triage, new Date(Date.now() + 60_000))).toEqual({ texts: 0, reports: 0 });
  });
});
