/**
 * The line's pass over the feature flags (Verify by variant): what it decides from the flags' state, and the pass
 * against the store, which closes an improvement whose flag Martin turned off, once, as turned off, with his reason.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import {
  DiskArtifacts,
  EventWriter,
  type FlagEvents,
  flagEvents,
  nextWorkItem,
  type StoredFlagRecord,
} from '@software-factory/store';
import type { Sql } from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { Stage } from '../../../../policy/flags.ts';
import { type FlagItem, flagsNext, itemsAsked } from '../../src/line/flags.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import { quiet } from '../github/fake.ts';
import { FakeGitHub, FakeSteps } from './fakes.ts';

const OFF = { stage: 'off' } as const;
const CHECKS = { stage: 'checks' } as const;
const PREVIEW = { stage: 'preview' } as const;
const SHARE = { stage: 'share', share: 50 } as const;
const EVERYONE = { stage: 'everyone' } as const;

let seq = 0;
const staged = (flag: string, workItem: string, from: Stage | null, to: Stage, reason?: string): StoredFlagRecord => ({
  type: 'flag.staged',
  seq: String(++seq),
  flag,
  workItem,
  from,
  to,
  ...(reason && { reason }),
});

const open: FlagItem = { improvement: true, sample: false, closed: false };

describe('what the flag pass decides', () => {
  /** A flag widened a stage at a time to `at`, then turned off from there. */
  const offFrom = (at: Stage): FlagEvents => {
    const path = [CHECKS, PREVIEW, SHARE, EVERYONE];
    const reached = path.slice(0, path.findIndex((s) => s.stage === at.stage) + 1);
    const records = reached.map((to, i) => staged('dates', '7', i === 0 ? OFF : (reached[i - 1] as Stage), to));
    return {
      named: { dates: '7' },
      records: [...records, staged('dates', '7', at, OFF, 'Wrong on Sundays')],
    };
  };

  it.each([CHECKS, PREVIEW, SHARE, EVERYONE])('closes the improvement turned off from %o, with the reason', (at) => {
    expect(flagsNext({ flags: offFrom(at), items: { '7': open }, only: null })).toEqual([
      { do: 'close', flag: 'dates', workItem: '7', from: at, reason: 'Wrong on Sundays' },
    ]);
  });

  it('asks only of the work items flags were last staged on', () => {
    expect(itemsAsked(offFrom(PREVIEW))).toEqual(['7']);
    expect(itemsAsked({ named: { dates: '7' }, records: [] })).toEqual([]);
  });

  it('closes nothing already closed, so nothing twice: not a flag turned back on and off again', () => {
    expect(flagsNext({ flags: offFrom(EVERYONE), items: { '7': { ...open, closed: true } }, only: null })).toEqual([]);
  });

  it('closes nothing but an open improvement of the factory’s own', () => {
    const flags = offFrom(CHECKS);
    expect(flagsNext({ flags, items: { '7': { ...open, improvement: false } }, only: null })).toEqual([]);
    expect(flagsNext({ flags, items: { '7': { ...open, sample: true } }, only: null })).toEqual([]);
    expect(flagsNext({ flags, items: {}, only: null })).toEqual([]);
  });

  it('closes nothing for a flag on, or turned off and widened again', () => {
    const on = { named: { dates: '7' }, records: [staged('dates', '7', OFF, CHECKS)] };
    expect(flagsNext({ flags: on, items: { '7': open }, only: null })).toEqual([]);
    const again = offFrom(CHECKS);
    again.records.push(staged('dates', '7', OFF, CHECKS));
    expect(flagsNext({ flags: again, items: { '7': open }, only: null })).toEqual([]);
  });

  it('closes a work item once, whichever of its flags was turned off', () => {
    const flags: FlagEvents = {
      named: { dates: '7' },
      records: [staged('dates', '7', CHECKS, OFF, 'No'), staged('old', '7', CHECKS, OFF, 'Nor this')],
    };
    expect(flagsNext({ flags, items: { '7': open }, only: null })).toHaveLength(1);
  });

  it('with just one, acts on that work item alone', () => {
    const flags: FlagEvents = {
      named: { dates: '7', wrap: '8' },
      records: [staged('dates', '7', CHECKS, OFF, 'No'), staged('wrap', '8', CHECKS, OFF, 'Nor this')],
    };
    const items = { '7': open, '8': open };
    expect(flagsNext({ flags, items, only: '8' }).map((next) => next.workItem)).toEqual(['8']);
    expect(flagsNext({ flags, items, only: '9' })).toEqual([]);
    expect(flagsNext({ flags, items, only: null }).map((next) => next.workItem)).toEqual(['7', '8']);
  });
});

describe('the flag pass, against the store', () => {
  let database: Database;
  let events: EventWriter;
  let now = Date.parse('2026-10-27T09:00:00Z');
  const writer = (sql: Sql) =>
    new EventWriter(sql, { kind: 'real', artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))) });

  beforeEach(async () => {
    database = await freshDatabase('flags');
    events = writer(database.as.line);
    now = Date.parse('2026-10-27T09:00:00Z');
  });
  afterEach(() => database?.end());

  const event = <K extends NewEvent['type']>(
    workItem: string | null,
    type: K,
    payload: PayloadOf<K>,
    actor: NewEvent['actor'] = 'factory',
  ): NewEvent =>
    ({
      id: crypto.randomUUID(),
      ts: new Date(now).toISOString(),
      work_item: workItem,
      type,
      version: VERSIONS[type],
      actor,
      summary: `${type} for the test`,
      payload,
      artifacts: [],
    }) as NewEvent;

  /** An improvement Martin asked for, as triage opens it, whose spec, as the line records it, names the flag. */
  async function improvement(flag: string, kind: PayloadOf<'work-item.opened'>['kind'] = 'improvement') {
    const workItem = await nextWorkItem(database.as.triage);
    await writer(database.as.triage).append([
      event(workItem, 'work-item.opened', { kind, title: 'Delivery dates', sample: false }, 'martin'),
    ]);
    await events.append([
      event(
        workItem,
        'spec.written',
        {
          outcome: 'Each product says when it would arrive',
          criteria: [{ given: 'a product page', when: 'it is shown', expect: 'it says when it would arrive' }],
          scope: ['src/pages/product.ts'],
          risks: [],
          rollout: 'Behind its flag',
          flag,
        },
        'planner',
      ),
    ]);
    return workItem;
  }

  /** Martin's move of a flag, as the admin service appends it. */
  const move = (workItem: string, flag: string, from: Stage | null, to: Stage, reason?: string, sql = database.admin) =>
    writer(sql).append([
      event(
        workItem,
        'flag.staged',
        {
          flag,
          from,
          to,
          action: to.stage === 'off' ? 'flag.off' : from?.stage === 'off' ? 'flag.to-checks' : 'flag.widen',
          revision: `r${++seq}`,
          ...(reason && { reason }),
          steppedUp: false,
        },
        'martin',
      ),
    ]);

  const line = (options: Partial<LineOptions> = {}) => {
    const it = new Line({
      sql: database.as.line,
      events,
      steps: new FakeSteps(database.as.gateway, {}),
      github: new FakeGitHub(),
      log: quiet,
      me: 'test',
      now: () => new Date(now),
      ...options,
    });
    return {
      pass: async () => {
        await it.tick();
        await it.idle();
      },
    };
  };

  const closes = (workItem: string) =>
    database.owner<{ actor: string; appended_by: string; summary: string; payload: PayloadOf<'work-item.closed'> }[]>`
      select actor, appended_by, summary, payload from events
      where work_item = ${workItem} and type = 'work-item.closed' order by seq`;

  it('closes an improvement turned off as turned off, with Martin’s reason, once', async () => {
    const workItem = await improvement('dates');
    await move(workItem, 'dates', OFF, CHECKS);
    await move(workItem, 'dates', CHECKS, PREVIEW);
    const { pass } = line();
    await pass();
    expect(await closes(workItem)).toEqual([]);

    await move(workItem, 'dates', PREVIEW, OFF, 'The date is wrong on Sundays');
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toEqual([
      {
        actor: 'factory',
        appended_by: 'factory_line',
        summary: 'Closed: Martin turned dates off, from Preview',
        payload: { outcome: 'turned-off', reason: 'The date is wrong on Sundays' },
      },
    ]);
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  it('closes one turned off from Everyone too, which may still go straight back on, and closes nothing more', async () => {
    const workItem = await improvement('wrap');
    await move(workItem, 'wrap', SHARE, EVERYONE);
    await move(workItem, 'wrap', EVERYONE, OFF, 'Wrapped the wrong way');
    const { pass } = line();
    await pass();
    expect((await closes(workItem)).map((c) => c.payload.outcome)).toEqual(['turned-off']);
    // Back on from Everyone after it closed, then off again: the work item is closed, and stays closed once.
    await move(workItem, 'wrap', OFF, EVERYONE);
    await move(workItem, 'wrap', EVERYONE, OFF, 'Still the wrong way');
    now += 30_000;
    await pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  it('reads the flags no oftener than every thirty seconds', async () => {
    const workItem = await improvement('soon');
    const { pass } = line();
    await pass();
    await move(workItem, 'soon', CHECKS, OFF, 'Not yet');
    now += 10_000;
    await pass();
    expect(await closes(workItem)).toEqual([]);
    now += 20_000;
    await pass();
    expect(await closes(workItem)).toHaveLength(1);
  });

  it('ignores a move a role not Martin’s appended', async () => {
    const workItem = await improvement('forged');
    // Row security refuses it from the line's role; were that guard to fail, the pass would still not believe it.
    await database.owner`alter table events disable row level security`;
    try {
      await move(workItem, 'forged', CHECKS, OFF, 'Forged', database.as.line);
    } finally {
      await database.owner`alter table events enable row level security`;
    }
    await line().pass();
    expect(await closes(workItem)).toEqual([]);
    expect((await flagEvents(database.as.line)).records).toEqual([]);
  });

  it('closes nothing but an improvement', async () => {
    const workItem = await improvement('fix', 'defect-fix');
    await move(workItem, 'fix', CHECKS, OFF, 'Not an improvement');
    await line().pass();
    expect(await closes(workItem)).toEqual([]);
  });

  it('with just one, acts on that work item alone', async () => {
    const one = await improvement('one');
    const other = await improvement('other');
    await move(one, 'one', CHECKS, OFF, 'This one');
    await move(other, 'other', CHECKS, OFF, 'The other');
    await line({ only: one }).pass();
    expect(await closes(one)).toHaveLength(1);
    expect(await closes(other)).toEqual([]);
  });

  it('judges the flags in a dry run too', async () => {
    const workItem = await improvement('dry');
    await move(workItem, 'dry', CHECKS, OFF, 'Off in a dry run');
    await line({ dryRun: true }).pass();
    expect(await closes(workItem)).toHaveLength(1);
  });
});
