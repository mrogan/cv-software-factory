/**
 * The line's comparison of what the admin service changes with the events that name each change (line/admin-actions.ts):
 * the flags, the app's Rollout's controls and the sessions, as an OpenTelemetry SDK collects it, with the store as the
 * line's role reads it and Kubernetes as a fake that answers with the objects given. Each collection is read on its own
 * (delta), so a test sees what that comparison reported, and none before it.
 */
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { VERSIONS } from '@software-factory/events';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { flagsSpec, readFlags, type Stage } from '../../../../policy/flags.ts';
import type { Kube } from '../../src/runners/kube.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.DELTA),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
const { flagsNamed, observeAdminActions, rolloutNamed, sessionsUnnamed, SIGN_IN_WITHIN_MS } = await import(
  '../../src/line/admin-actions.ts'
);

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

const checks: Stage = { stage: 'checks' };
const share: Stage = { stage: 'share', share: 25 };
const everyone: Stage = { stage: 'everyone' };
const held = (stages: Record<string, Stage>, revision: string) => readFlags(flagsSpec(stages, revision));

describe('the flags, named by Martin’s moves', () => {
  const moves = [
    { flag: 'delivery-dates', to: checks, revision: 'r1' },
    { flag: 'gift-wrap', to: checks, revision: 'r2' },
    { flag: 'delivery-dates', to: share, revision: 'r3' },
  ];

  it('are named when each flag is at his latest move of it, and the revision is one a move wrote', () => {
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': checks }, 'r3'), moves)).toBe(true);
    // A revision an earlier move wrote names the set too, whatever order two moves' events were stored in.
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': checks }, 'r2'), moves)).toBe(true);
    // A flag at Off is as good as no flag, either way.
    expect(
      flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': checks, other: { stage: 'off' } }, 'r3'), moves),
    ).toBe(true);
  });

  it('are named as Argo CD makes them, with no flag and no revision, and before any move', () => {
    expect(flagsNamed(readFlags({ flagSpec: { flags: {} } }), [])).toBe(true);
    expect(flagsNamed(readFlags(undefined), [])).toBe(true);
    expect(flagsNamed(undefined, [])).toBe(true);
  });

  it('are not named gone, or set back to no flag and no revision, once a move of his set a flag there', () => {
    expect(flagsNamed(undefined, moves)).toBe(false);
    expect(flagsNamed(readFlags({ flagSpec: { flags: {} } }), moves)).toBe(false);
    // Every flag he moved turned off, with no revision: still no write of his.
    const offs = [{ flag: 'delivery-dates', to: { stage: 'off' } as Stage, revision: 'r1' }];
    expect(flagsNamed(readFlags({ flagSpec: { flags: {} } }), offs)).toBe(false);
  });

  it('are not named with a revision no move wrote, as one bumped by hand', () => {
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': checks }, 'r4'), moves)).toBe(false);
    expect(flagsNamed(held({}, 'r1'), [])).toBe(false);
  });

  it('are not named with a flag at a stage his latest move did not set, whatever the revision', () => {
    // Widened by hand, keeping the revision: the revision alone would hide it.
    expect(flagsNamed(held({ 'delivery-dates': everyone, 'gift-wrap': checks }, 'r3'), moves)).toBe(false);
    expect(
      flagsNamed(held({ 'delivery-dates': { stage: 'share', share: 50 }, 'gift-wrap': checks }, 'r3'), moves),
    ).toBe(false);
    // A flag no move staged.
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': checks, other: checks }, 'r3'), moves)).toBe(false);
    // Taken away by hand: off, where his move left it at Checks.
    expect(flagsNamed(held({ 'delivery-dates': share }, 'r3'), moves)).toBe(false);
  });

  it('are not named with a flag in no stage’s shape, or flags with no revision', () => {
    const { flagSpec } = flagsSpec({ 'delivery-dates': share, 'gift-wrap': checks }, 'r3');
    const odd = { flagSpec: { flags: { ...flagSpec.flags, odd: { state: 'ENABLED', variants: { on: true } } } } };
    expect(flagsNamed(readFlags(odd), moves)).toBe(false);
    const { 'flag-set-revision': _, ...without } = flagSpec.flags;
    expect(flagsNamed(readFlags({ flagSpec: { flags: without } }), moves)).toBe(false);
  });

  it('take a flag a move dropped as off', () => {
    const dropping = [...moves, { flag: 'gift-wrap', to: everyone, revision: 'r4', dropped: ['odd'] }];
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': everyone }, 'r4'), dropping)).toBe(true);
    const back = [{ flag: 'odd', to: checks, revision: 'r1' }, ...dropping];
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': everyone }, 'r4'), back)).toBe(true);
    expect(flagsNamed(held({ 'delivery-dates': share, 'gift-wrap': everyone, odd: checks }, 'r4'), back)).toBe(false);
  });
});

describe('the Rollout’s controls, named by Martin’s', () => {
  const control = (action: string, release = 'website-7d9f8b6c4-3') => ({
    type: 'release.controlled' as const,
    action,
    release,
  });
  const startedOf = (release: string) => ({ type: 'release.started' as const, release });
  const started = startedOf('website-7d9f8b6c4-3');
  const stopped = { type: 'line.stopped' as const };
  const as = (paused: boolean, promoteFull = false) => ({ paused, promoteFull });

  it('are named paused only after his latest pause or resume was a pause', () => {
    expect(rolloutNamed(as(true), [control('pause')])).toBe(true);
    // A promotion, an abort or a retry that could not clear his pause leaves it set, and named.
    expect(rolloutNamed(as(true), [control('pause'), control('abort')])).toBe(true);
    expect(rolloutNamed(as(true), [control('pause'), started])).toBe(true);
    expect(rolloutNamed(as(true), [])).toBe(false);
    expect(rolloutNamed(as(true), [control('pause'), control('resume')])).toBe(false);
    expect(rolloutNamed(as(true), [control('promote')])).toBe(false);
  });

  it('are named not paused unless his latest pause has had nothing since that clears it', () => {
    expect(rolloutNamed(as(false), [])).toBe(true);
    for (const after of [control('resume'), control('promote'), control('abort'), control('retry'), stopped]) {
      expect(rolloutNamed(as(false), [control('pause'), after]), JSON.stringify(after)).toBe(true);
    }
    expect(rolloutNamed(as(false), [control('pause')])).toBe(false);
    // A release starting clears no pause: Argo Rollouts keeps it.
    expect(rolloutNamed(as(false), [control('pause'), started])).toBe(false);
  });

  it('are named promoted fully only after his full promotion of the release the line recorded starting last', () => {
    expect(rolloutNamed(as(false, true), [started, control('promote-fully')])).toBe(true);
    expect(rolloutNamed(as(false, true), [started, control('promote-fully'), control('abort')])).toBe(true);
    // The same release recorded starting again, on another work item it carries: still his.
    expect(rolloutNamed(as(false, true), [started, control('promote-fully'), started])).toBe(true);
    // Before the line has recorded any release, any full promotion of his.
    expect(rolloutNamed(as(false, true), [control('promote-fully')])).toBe(true);
    // A full promotion of the release before names none of the next.
    const next = startedOf('website-5c8d7b9f4-4');
    expect(rolloutNamed(as(false, true), [started, control('promote-fully'), next])).toBe(false);
    expect(rolloutNamed(as(false, true), [started, control('promote')])).toBe(false);
    expect(rolloutNamed(as(false, true), [])).toBe(false);
  });

  it('are named gone only before the line has recorded a release of it', () => {
    expect(rolloutNamed(undefined, [])).toBe(true);
    expect(rolloutNamed(undefined, [control('pause')])).toBe(true);
    expect(rolloutNamed(undefined, [started])).toBe(false);
  });
});

describe('the sessions, each named by a sign-in', () => {
  it('are named by a sign-in at or within a minute after each started, one sign-in each', () => {
    expect(sessionsUnnamed([], [])).toBe(0);
    expect(sessionsUnnamed([1000], [1000])).toBe(0);
    expect(sessionsUnnamed([1000], [1000 + SIGN_IN_WITHIN_MS])).toBe(0);
    expect(sessionsUnnamed([1000, 2000], [2500, 1500])).toBe(0);
    // One sign-in names one session, not two at once.
    expect(sessionsUnnamed([1000, 1001], [1500])).toBe(1);
  });

  it('leave a session unnamed with no sign-in, or only one before it or too long after', () => {
    expect(sessionsUnnamed([1000], [])).toBe(1);
    expect(sessionsUnnamed([1000], [999])).toBe(1);
    expect(sessionsUnnamed([1000], [1001 + SIGN_IN_WITHIN_MS])).toBe(1);
    // A sign-in that could be either's goes to the earlier, so the later one with a sign-in of its own is named too.
    expect(sessionsUnnamed([0, 30_000], [30_000, 70_000])).toBe(0);
  });
});

describe('the comparison, as the SDK collects it', () => {
  let database: Database;
  beforeEach(async () => {
    database = await freshDatabase('line_admin_actions');
  });
  afterEach(() => database?.end());

  const FLAGS = { namespace: 'flagd', name: 'flags' };
  const KEY = 'passkey-of-martin-1';
  const ROLLOUT = { namespace: 'website', name: 'website' };

  /** Kubernetes as a fake: the FeatureFlag and the Rollout as given, read through the caller's schema. */
  const kubeOf = (objects: { flags?: unknown; rollout?: unknown; fails?: boolean }): Kube => ({
    async get<T>(path: string, schema: z.ZodType<T>) {
      if (objects.fails) throw new Error('Kubernetes is away');
      const object = path.includes('/featureflags/') ? objects.flags : objects.rollout;
      return object === undefined ? undefined : schema.parse(object);
    },
    text: async () => undefined,
    create: async () => {},
    remove: async () => {},
  });

  /** Appends an event straight to the store as `sql`'s role, as the admin service and the line would. */
  async function append(sql: Sql, type: string, payload: object, { workItem = '1' as string | null } = {}) {
    await sql`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), ${workItem}, ${type}, ${VERSIONS[type as keyof typeof VERSIONS] ?? 1},
              'martin', ${type}, ${sql.json(payload as never)}, '[]', '{}', false)`;
  }

  /** Each action's figures, as the SDK collects them now. */
  async function collected(): Promise<Record<string, { uncounted?: number; compared?: number }>> {
    const { resourceMetrics } = await reader.collect();
    const all = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
    const by: Record<string, { uncounted?: number; compared?: number }> = {};
    for (const [name, key] of [
      ['line.admin_actions.uncounted', 'uncounted'],
      ['line.admin_actions.compared', 'compared'],
    ] as const) {
      for (const point of all.find((m) => m.descriptor.name === name)?.dataPoints ?? []) {
        const action = String(point.attributes.action);
        by[action] = { ...by[action], [key]: point.value as number };
      }
    }
    return by;
  }

  const staged = (flag: string, to: Stage, revision: string) => ({
    flag,
    from: null,
    to,
    action: 'flag.to-checks',
    revision,
    steppedUp: false,
  });

  it('finds every change named, the flags, the Rollout and the sessions, from the events Martin’s roles appended', async () => {
    const { admin, as } = database;
    await append(admin, 'flag.staged', staged('delivery-dates', checks, 'r1'));
    await append(admin, 'release.controlled', {
      action: 'pause',
      release: 'website-7d9f8b6c4-3',
      version: '1.2.3',
      weight: 10,
    });
    const kube = kubeOf({
      flags: { spec: flagsSpec({ 'delivery-dates': checks }, 'r1') },
      rollout: { spec: { paused: true }, status: {} },
    });
    const stop = observeAdminActions({ sql: as.line, kube, flags: FLAGS, rollout: ROLLOUT }, pino({ level: 'silent' }));
    try {
      expect(await collected()).toEqual({
        flags: { uncounted: 0, compared: 1 },
        rollout: { uncounted: 0, compared: 1 },
        sessions: { uncounted: 0, compared: 1 },
      });
    } finally {
      stop();
    }
  });

  it('finds a change no event names: a revision bumped by hand, a pause, a session with no sign-in', async () => {
    const { admin, owner, as } = database;
    await append(admin, 'flag.staged', staged('delivery-dates', checks, 'r1'));
    await owner`insert into enrolment_codes (code_sha256) values (${'c'.repeat(64)})`;
    await owner`insert into passkeys (id, public_key, name, enrolled_with)
                values (${KEY}, '\\x00', 'Phone', ${'c'.repeat(64)})`;
    // Made by hand, outside the sign-in: no event names it.
    await admin`insert into sessions (id_sha256, passkey) values (${'a'.repeat(64)}, ${KEY})`;
    const kube = kubeOf({
      flags: { spec: flagsSpec({ 'delivery-dates': checks }, 'drill-1') },
      rollout: { spec: { paused: true } },
    });
    const stop = observeAdminActions({ sql: as.line, kube, flags: FLAGS, rollout: ROLLOUT }, pino({ level: 'silent' }));
    try {
      expect(await collected()).toEqual({
        flags: { uncounted: 1, compared: 1 },
        rollout: { uncounted: 1, compared: 1 },
        sessions: { uncounted: 1, compared: 1 },
      });
      // Signed in as the admin service does, in one transaction with its event: named.
      await admin.begin(async (tx) => {
        await tx`insert into sessions (id_sha256, passkey) values (${'b'.repeat(64)}, ${KEY})`;
        await append(tx as unknown as Sql, 'admin.signed-in', { passkey: 'Phone' }, { workItem: null });
      });
      expect((await collected()).sessions).toEqual({ uncounted: 1, compared: 1 });
      // A sign-in recorded a moment after it, as the store's lock might make it, names it too.
      await append(admin, 'admin.signed-in', { passkey: 'Phone' }, { workItem: null });
      expect((await collected()).sessions).toEqual({ uncounted: 0, compared: 1 });
    } finally {
      stop();
    }
  });

  it('compares neither the flags nor the Rollout when the line is not given them, and names what is not there', async () => {
    const stop = observeAdminActions(
      { sql: database.as.line, kube: kubeOf({ fails: true }), flags: null, rollout: null },
      pino({ level: 'silent' }),
    );
    try {
      expect(await collected()).toEqual({ sessions: { uncounted: 0, compared: 1 } });
    } finally {
      stop();
    }
    const none = observeAdminActions(
      { sql: database.as.line, kube: kubeOf({}), flags: FLAGS, rollout: ROLLOUT },
      pino({ level: 'silent' }),
    );
    try {
      expect(await collected()).toEqual({
        flags: { uncounted: 0, compared: 1 },
        rollout: { uncounted: 0, compared: 1 },
        sessions: { uncounted: 0, compared: 1 },
      });
    } finally {
      none();
    }
  });

  it('starts no second comparison of one still running, and takes its answer when it comes', async () => {
    let reads = 0;
    let answer: (() => void) | undefined;
    const slow: Kube = {
      ...kubeOf({}),
      get: () => {
        reads++;
        return new Promise((resolve) => {
          answer = () => resolve(undefined);
        });
      },
    };
    // The test ends the flags' time itself, so no clock decides: at once while the read is held, then never. The
    // sessions, read from the store, are given all the time they take.
    let deadline = AbortSignal.abort();
    const stop = observeAdminActions(
      { sql: database.as.line, kube: slow, flags: FLAGS, rollout: null },
      pino({ level: 'silent' }),
      (action) => (action === 'flags' ? deadline : new AbortController().signal),
    );
    try {
      expect((await collected()).flags).toEqual({ compared: 0 });
      expect((await collected()).flags).toEqual({ compared: 0 });
      expect(reads).toBe(1);
      deadline = new AbortController().signal;
      answer?.();
      expect((await collected()).flags).toEqual({ uncounted: 0, compared: 1 });
      expect(reads).toBe(1);
    } finally {
      stop();
    }
  });

  it('reads a release started before releases were named as the line does, upcast', async () => {
    const { admin, as } = database;
    // Version 1 named no release: the line reads its version as its name.
    await as.line`
      insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
      values (${crypto.randomUUID()}, now(), '1', 'release.started', 1, 'factory', 'release.started',
              ${as.line.json({ version: '1.2.3', previous: '1.2.2', digest: `sha256:${'a'.repeat(64)}`, signed: true, admitted: true } as never)},
              '[]', '{}', false)`;
    await append(admin, 'release.controlled', {
      action: 'promote-fully',
      release: '1.2.3',
      version: '1.2.3',
      weight: 10,
      to: 100,
    });
    const kube = kubeOf({ rollout: { spec: {}, status: { promoteFull: true } } });
    const stop = observeAdminActions({ sql: as.line, kube, flags: null, rollout: ROLLOUT }, pino({ level: 'silent' }));
    try {
      expect((await collected()).rollout).toEqual({ uncounted: 0, compared: 1 });
    } finally {
      stop();
    }
  });

  it('says it could not compare one that takes too long, so the SDK never drops the collection', async () => {
    const slow: Kube = { ...kubeOf({}), get: () => new Promise(() => {}) };
    const stop = observeAdminActions(
      { sql: database.as.line, kube: slow, flags: FLAGS, rollout: null },
      pino({ level: 'silent' }),
      (action) => (action === 'flags' ? AbortSignal.abort() : new AbortController().signal),
    );
    try {
      expect(await collected()).toEqual({ flags: { compared: 0 }, sessions: { uncounted: 0, compared: 1 } });
    } finally {
      stop();
    }
  });

  it('says it could not compare while Kubernetes or the store cannot be read, and logs it once', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const kube = kubeOf({ fails: true });
    const stop = observeAdminActions({ sql: database.as.line, kube, flags: FLAGS, rollout: ROLLOUT }, log);
    try {
      expect(await collected()).toEqual({
        flags: { compared: 0 },
        rollout: { compared: 0 },
        sessions: { uncounted: 0, compared: 1 },
      });
      await collected();
      const warned = lines.filter((line) => line.includes('could not compare'));
      expect(warned.map((line) => JSON.parse(line).action).sort()).toEqual(['flags', 'rollout']);
    } finally {
      stop();
    }
  });
});
