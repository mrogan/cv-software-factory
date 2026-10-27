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
import { release as RELEASE } from '../../../../policy/release.ts';
import type { Sample } from '../../src/clients/http.ts';
import type { Prometheus } from '../../src/clients/prometheus.ts';
import { sidesOf } from '../../src/line/compare.ts';
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
  ts: new Date(Date.parse('2026-10-27T09:00:00Z') + seq * 60_000).toISOString(),
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

  it('compares a flag at Share, once for each move there, and nothing at any other stage', () => {
    const records = [staged('dates', '7', OFF, CHECKS), staged('dates', '7', CHECKS, SHARE)];
    const move = records[1] as StoredFlagRecord;
    const flags: FlagEvents = { named: { dates: '7' }, records };
    expect(flagsNext({ flags, items: { '7': open }, only: null })).toEqual([
      { do: 'compare', flag: 'dates', workItem: '7', share: 50, move: { seq: move.seq, ts: move.ts } },
    ]);
    const compared: StoredFlagRecord = {
      type: 'flag.compared',
      seq: String(++seq),
      ts: move.ts,
      flag: 'dates',
      share: 50,
      outcome: 'passed',
    };
    expect(
      flagsNext({ flags: { ...flags, records: [...records, compared] }, items: { '7': open }, only: null }),
    ).toEqual([]);
    // A narrower share is a move of its own, compared afresh.
    const narrowed = [...records, compared, staged('dates', '7', SHARE, { stage: 'share', share: 25 })];
    expect(flagsNext({ flags: { ...flags, records: narrowed }, items: { '7': open }, only: null })).toMatchObject([
      { do: 'compare', share: 25 },
    ]);
    const checks = { ...flags, records: [records[0] as StoredFlagRecord] };
    expect(flagsNext({ flags: checks, items: { '7': open }, only: null })).toEqual([]);
    // On a closed work item too: a flag back on from Everyone after it closed may be narrowed to Share, and Everyone
    // waits on the comparison.
    expect(flagsNext({ flags, items: { '7': { ...open, closed: true } }, only: null })).toMatchObject([
      { do: 'compare' },
    ]);
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

  describe('comparing a flag at Share', () => {
    const MINUTE = 60_000;
    /** Past the minute the app has to hold the move, and the window the comparison needs. */
    const enough = (1 + RELEASE.flags.windowMinutes + 1) * MINUTE;

    /**
     * Prometheus, as the line asks it for the generator's figures: each id five requests a second shared by 101, for
     * as long as each piece asked for, all fast; the ids `worse` names answer a tenth of them 5xx.
     */
    function prometheus(worse: readonly string[] = []) {
      const asked: { seconds: number; at: number }[] = [];
      const fake = {
        async instant(query: string, at?: Date): Promise<Sample[]> {
          const seconds = Number(/\[(\d+)s\]/.exec(query)?.[1]);
          asked.push({ seconds, at: at?.getTime() ?? Number.NaN });
          const each = (seconds * RELEASE.traffic.requestsPerSecond) / 101;
          return Array.from({ length: 101 }, (_, i) => `traffic-${String(i).padStart(3, '0')}`).flatMap((id) => {
            const errors = worse.includes(id) ? each / 10 : 0;
            const bucket = (status_class: string, le: string, value: number) => ({
              labels: { share_id: id, status_class, le },
              value,
            });
            return [
              bucket('2xx', '0.1', each - errors),
              bucket('2xx', '+Inf', each - errors),
              ...(errors ? [bucket('5xx', '0.1', errors), bucket('5xx', '+Inf', errors)] : []),
            ];
          });
        },
      };
      return { fake: fake as unknown as Prometheus, asked };
    }

    const compared = (workItem: string) =>
      database.owner<{ actor: string; appended_by: string; summary: string; payload: PayloadOf<'flag.compared'> }[]>`
        select actor, appended_by, summary, payload from events
        where work_item = ${workItem} and type = 'flag.compared' order by seq`;

    /** A release in the line's record, on the line. */
    const released = (type: 'release.started' | 'release.promoted', id: string, dryRun = false, watched = true) =>
      events.append([
        type === 'release.started'
          ? event(null, type, {
              release: id,
              version: 'v0.9.8',
              previous: 'v0.9.7',
              watched,
              steps: null,
              dryRun,
              ...(!dryRun && { image: { digest: `sha256:${'c'.repeat(64)}`, signed: true, admitted: true } }),
            })
          : event(null, type, { release: id, version: 'v0.9.8', previous: 'v0.9.7', watched: true, dryRun }),
      ]);

    /** An improvement at Share 50%, moved there now. */
    async function atShare(flag: string) {
      const workItem = await improvement(flag);
      await move(workItem, flag, OFF, CHECKS);
      await move(workItem, flag, CHECKS, SHARE);
      return { workItem, movedAt: now };
    }

    it('waits for the window, then compares once, passed, from a minute after Martin’s move', async () => {
      const { workItem, movedAt } = await atShare('dates');
      const { fake, asked } = prometheus();
      const { pass } = line({ verify: { prometheus: fake } });
      now += enough - 2 * MINUTE;
      await pass();
      expect(await compared(workItem)).toEqual([]);
      expect(asked).toEqual([]);

      now += 2 * MINUTE;
      await pass();
      const [one, ...more] = await compared(workItem);
      expect(more).toEqual([]);
      expect(one).toMatchObject({
        actor: 'factory',
        appended_by: 'factory_line',
        summary: 'dates at Share 50%: flag on against off passed',
        payload: {
          flag: 'dates',
          share: 50,
          window: { from: new Date(movedAt + MINUTE).toISOString(), to: new Date(now).toISOString() },
          setAsideMinutes: 0,
          outcome: 'passed',
          sides: { on: { errorRate: 0, p99Ms: 99 }, off: { errorRate: 0, p99Ms: 99 } },
        },
      });
      expect(one?.payload.reason).toBeUndefined();
      const sides = sidesOf('dates', 50);
      expect(one?.payload.sides.on.requests).toBe(Math.round(((enough - MINUTE) / 1000) * 5 * (sides.on.length / 101)));
      expect(asked).toEqual([{ seconds: (enough - MINUTE) / 1000, at: now }]);

      now += 30_000;
      await pass();
      expect(await compared(workItem)).toHaveLength(1);
    });

    it('fails a side with more errors, with the reason in words', async () => {
      const { workItem } = await atShare('dates');
      const { fake } = prometheus(sidesOf('dates', 50).on);
      now += enough;
      await line({ verify: { prometheus: fake } }).pass();
      expect(await compared(workItem)).toMatchObject([
        {
          summary: 'dates at Share 50%: flag on against off failed',
          payload: { outcome: 'failed', reason: 'Errors 10.00% with the flag on against 0.00% off' },
        },
      ]);
    });

    it('sets a canary’s time in flight aside, padded by how often the line reads releases, and counts it', async () => {
      const { workItem, movedAt } = await atShare('dates');
      const { fake, asked } = prometheus();
      const { pass } = line({ verify: { prometheus: fake } });
      now += 5 * MINUTE;
      await released('release.started', 'canary-1');
      now += 10 * MINUTE;
      await released('release.promoted', 'canary-1');
      now += enough - 15 * MINUTE;
      await pass();
      // Eleven minutes of the window were a canary's, so it is not yet long enough.
      expect(await compared(workItem)).toEqual([]);

      now += 11 * MINUTE;
      await pass();
      expect(await compared(workItem)).toMatchObject([{ payload: { outcome: 'passed', setAsideMinutes: 11 } }]);
      // One question for each piece: from the minute after the move to the canary's start, padded, and from its
      // promotion, padded, to now.
      expect(asked.slice(-2)).toEqual([
        { seconds: 3.5 * 60, at: movedAt + 4.5 * MINUTE },
        { seconds: (now - movedAt - 15.5 * MINUTE) / 1000, at: now },
      ]);
    });

    it('runs a canary still in flight to now, and leaves out a dry run’s and a version found live', async () => {
      const inFlight = await atShare('dates');
      const { fake } = prometheus();
      now += 5 * MINUTE;
      await released('release.started', 'canary-2');
      now += enough;
      await line({ verify: { prometheus: fake } }).pass();
      expect(await compared(inFlight.workItem)).toEqual([]);

      await released('release.promoted', 'canary-2');
      const dry = await atShare('wraps');
      // Only one flag is at Share at a time; the other is turned off, and closes.
      await move(inFlight.workItem, 'dates', SHARE, OFF, 'Not now');
      await released('release.started', 'dry-1', true);
      // A version found live is recorded started and promoted at once: no canary.
      await released('release.started', 'found-1', false, false);
      await released('release.promoted', 'found-1');
      now += enough;
      await line({ verify: { prometheus: fake } }).pass();
      expect(await compared(dry.workItem)).toMatchObject([{ payload: { outcome: 'passed', setAsideMinutes: 0 } }]);
    });

    it('sets aside each attempt of a retried release, and a retry still in flight runs to now', async () => {
      const { workItem } = await atShare('dates');
      const { fake } = prometheus();
      const { pass } = line({ verify: { prometheus: fake } });
      now += 5 * MINUTE;
      await released('release.started', 'canary-3');
      now += 5 * MINUTE;
      await events.append([
        event(null, 'release.aborted', {
          release: 'canary-3',
          version: 'v0.9.8',
          restored: 'v0.9.7',
          abortedAt: new Date(now).toISOString(),
          by: 'martin',
        }),
      ]);
      now += 10 * MINUTE;
      await released('release.started', 'canary-3');
      now += enough;
      await pass();
      // The retry is still in flight: the window is only what came before it, less the first attempt.
      expect(await compared(workItem)).toEqual([]);
      await released('release.promoted', 'canary-3');
      now += enough;
      await pass();
      // Six minutes for the first attempt and the retry's span for the second, each padded by a minute in all.
      expect(await compared(workItem)).toMatchObject([
        { payload: { outcome: 'passed', setAsideMinutes: 6 + enough / MINUTE + 1 } },
      ]);
    });

    it('waits without Prometheus', async () => {
      const { workItem } = await atShare('dates');
      now += enough;
      await line().pass();
      expect(await compared(workItem)).toEqual([]);
    });
  });
});
