/**
 * The line's count of Martin's security events and of the holds started, read from the store (line/security.ts), as an
 * OpenTelemetry SDK collects it: a meter provider is installed for this file before the module loads, as `telemetry.ts`
 * is before the line's.
 */
import { metrics as api } from '@opentelemetry/api';
import { metrics } from '@opentelemetry/sdk-node';
import { HOLD_CAUSES, RELEASE_CONTROLS, VERSIONS } from '@software-factory/events';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { ACCESS, GUARDRAIL_HOLDS } from '../../../../policy/access.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
const { countAs, emptyTally, observeSecurity, readOn, SECURITY_KINDS, STEPPED_UP_CONTROLS } = await import(
  '../../src/line/security.ts'
);

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('line_security');
});
afterEach(() => database?.end());

/** Appends an event straight to the store as `sql`'s role, unchecked: what is counted is what the store holds. */
async function append(
  sql: Sql,
  type: string,
  payload: object,
  workItem: string | null = null,
  { version = VERSIONS[type as keyof typeof VERSIONS] ?? 1, sample = false } = {},
): Promise<void> {
  await sql`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), ${workItem}, ${type}, ${version}, 'martin', ${type},
            ${sql.json(payload as never)}, '[]', '{}', ${sample})`;
}

/** Each kind's and each cause's figure, as the SDK collects them now. */
async function collected(): Promise<{ kinds: Record<string, number>; holds: Record<string, number> }> {
  const { resourceMetrics } = await reader.collect();
  const all = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
  const of = (name: string, label: string) =>
    Object.fromEntries(
      (all.find((m) => m.descriptor.name === name)?.dataPoints ?? []).map((p) => [
        String(p.attributes[label]),
        p.value as number,
      ]),
    );
  return { kinds: of('line.security_events', 'kind'), holds: of('line.holds.stored', 'cause') };
}

/** Whether the last read succeeded, as the SDK collects it now. */
async function gauge(): Promise<number | undefined> {
  const { resourceMetrics } = await reader.collect();
  const metric = resourceMetrics.scopeMetrics
    .flatMap((scope) => scope.metrics)
    .find((m) => m.descriptor.name === 'line.security_events.counting');
  return metric?.dataPoints.at(-1)?.value as number | undefined;
}

describe('the count of Martin’s security events', () => {
  it('reports every kind and every cause, each from 0, before any has happened', async () => {
    const stop = observeSecurity(database.as.line, pino({ level: 'silent' }));
    try {
      const { kinds, holds } = await collected();
      expect(kinds).toEqual(Object.fromEntries(SECURITY_KINDS.map((kind) => [kind, 0])));
      expect(holds).toEqual(Object.fromEntries(HOLD_CAUSES.map((cause) => [cause, 0])));
    } finally {
      stop();
    }
  });

  it('counts each kind from the stored events, whatever role appended them, and nothing else', async () => {
    const { admin, operator } = database;
    await append(admin, 'admin.signed-in', { passkey: 'laptop' });
    await append(admin, 'admin.signed-in', {});
    await append(admin, 'admin.signed-out', { everywhere: false });
    await append(admin, 'admin.stepped-up', {});
    await append(operator, 'passkey.enrolled', {});
    await append(operator, 'passkey.revoked', { from: 'command-line' });
    await append(admin, 'settings.changed', {});
    await append(operator, 'line.started', { autonomy: 'supervised' });
    await append(operator, 'line.stopped', { reason: 'night' });
    for (const action of RELEASE_CONTROLS) await append(admin, 'release.controlled', { action });
    await append(admin, 'controls.changed', {
      change: { control: 'autonomy', before: 'supervised', after: 'guarded' },
    });
    await append(admin, 'controls.changed', { change: { control: 'take', before: null, after: { kind: 'every' } } });
    await append(admin, 'controls.changed', { change: { control: 'new-work', before: true, after: false } });
    await append(database.as.line, 'model.called', {});

    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds).toEqual({
      'sign-in': 2,
      'passkey-enrolled': 1,
      'passkey-revoked': 1,
      'setting-changed': 1,
      'stepped-up': 1,
      'release-control': STEPPED_UP_CONTROLS.length,
      'guardrail-approved': 0,
      'line-started': 1,
      'autonomy-loosened': 1,
      'autonomy-tightened': 0,
      'new-work-on': 0,
      'new-work-off': 1,
      'auto-merge-on': 0,
      'auto-merge-off': 0,
      'take-widened': 1,
      'take-narrowed': 0,
    });
  });

  it('tells a guardrail’s approval by the cause of the hold it answers, read from the store', async () => {
    const { admin } = database;
    const hold = (workItem: string, cause: string) => append(database.as.line, 'hold.started', { cause }, workItem);
    const answer = (workItem: string, decision: string) => append(admin, 'hold.answered', { decision }, workItem);
    // A guardrail's hold approved: counted. Rejected or answered in words: not.
    await hold('WI-1', 'scope');
    await answer('WI-1', 'rejected');
    await answer('WI-1', 'answered');
    await answer('WI-1', 'approved');
    // Held again, for a cause that is no guardrail: its approval is not counted, though an earlier hold's was one.
    await hold('WI-1', 'spec');
    await answer('WI-1', 'approved');
    // Another work item's guardrail does not lend its cause.
    await hold('WI-2', 'merge');
    await hold('WI-3', 'question');
    await answer('WI-3', 'approved');
    // An answer with no hold before it on its work item: nothing to tell it by.
    await answer('WI-4', 'approved');
    await hold('WI-4', 'spend');

    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['guardrail-approved']).toBe(1);
    expect(tally.holds).toMatchObject({ scope: 1, spec: 1, merge: 1, question: 1, spend: 1, review: 0 });
  });

  it('reads a hold stored before holds had causes as the factory does, upcast', async () => {
    // A version 1 approval at Review implies a merge hold, a guardrail; a question implies none.
    await append(database.as.line, 'hold.started', { stage: 'review', kind: 'approval' }, 'WI-5', { version: 1 });
    await append(database.admin, 'hold.answered', { decision: 'approved' }, 'WI-5');
    await append(database.as.line, 'hold.started', { stage: 'plan', kind: 'question' }, 'WI-6', { version: 1 });
    await append(database.admin, 'hold.answered', { decision: 'approved' }, 'WI-6');
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['guardrail-approved']).toBe(1);
    expect(tally.holds).toMatchObject({ merge: 1, question: 1 });
  });

  it('counts nothing in a store of samples, which never happened', async () => {
    await append(database.operator, 'admin.signed-in', {}, null, { sample: true });
    await append(database.operator, 'hold.started', { cause: 'merge' }, 'WI-7', { sample: true });
    const tally = await readOn(database.as.line, emptyTally());
    expect(tally.kinds['sign-in']).toBe(0);
    expect(tally.holds.merge).toBe(0);
  });

  it('reads on from the last event it read, and reports the same figure from the start', async () => {
    const { admin } = database;
    await append(admin, 'admin.signed-in', {});
    const first = await readOn(database.as.line, emptyTally());
    expect(first.kinds['sign-in']).toBe(1);
    await append(admin, 'admin.signed-in', {});
    await append(database.as.line, 'hold.started', { cause: 'not-a-cause' }, 'WI-9');
    const next = await readOn(database.as.line, first);
    expect(next.kinds['sign-in']).toBe(2);
    expect(next.holds.unknown).toBe(1);
    expect(BigInt(next.seq)).toBeGreaterThan(BigInt(first.seq));
    // Nothing new: the same figures. And a reader that starts afresh, as a restarted line or a second replica, agrees.
    expect(await readOn(database.as.line, next)).toEqual(next);
    expect(await readOn(database.as.line, emptyTally())).toEqual(next);
  });

  it('says the count is stale while the store cannot be read, and logs it once', async () => {
    const warnings: string[] = [];
    const log = pino({ level: 'warn' }, { write: (line: string) => warnings.push(line) });
    await append(database.admin, 'admin.signed-in', {});
    // A store that refuses every query: a tagged call rejects, and the helper that makes its list makes nothing.
    const broken = ((strings: unknown) =>
      Array.isArray(strings) && 'raw' in strings
        ? Promise.reject(new Error('the store is down'))
        : {}) as unknown as Sql;
    const stop = observeSecurity(broken, log);
    try {
      expect(await gauge()).toBe(0);
      expect(await gauge()).toBe(0);
      expect(warnings.filter((line) => line.includes('could not count'))).toHaveLength(1);
    } finally {
      stop();
    }
    const working = observeSecurity(database.as.line, log);
    try {
      expect(await gauge()).toBe(1);
      expect((await collected()).kinds['sign-in']).toBe(1);
    } finally {
      working();
    }
  });
});

describe('what counts as a security event', () => {
  it('counts the release controls the access table marks as needing the passkey again, and no other', () => {
    const access = ACCESS as Record<string, { stepUp: boolean }>;
    const key = (action: string) => `release.${action === 'promote-fully' ? 'promote' : action}`;
    for (const action of RELEASE_CONTROLS) {
      expect(access[key(action)], action).toBeDefined();
      expect(countAs({ type: 'release.controlled', action }) !== null, action).toBe(access[key(action)]?.stepUp);
    }
  });

  it('counts every action that needs the passkey again, or names the event it waits for', () => {
    // Each action the access table marks, by the kind its event is counted as. Auto-rollback has no switch, and so no
    // event, until Part C gives it one: it joins the count then, and this test fails until it does.
    const counted: Record<string, string> = {
      'step-up': 'stepped-up',
      'passkey.revoke': 'passkey-revoked',
      'hold.approve-guardrail': 'guardrail-approved',
      'line.start': 'line-started',
      'release.promote': 'release-control',
      'release.retry': 'release-control',
      'agent.raise': 'setting-changed',
      'caps.raise': 'setting-changed',
      'autonomy.loosen': 'autonomy-loosened',
      'auto-merge.on': 'auto-merge-on',
      'auto-rollback.off': 'no event yet',
      'take.widen': 'take-widened',
    };
    const marked = Object.entries(ACCESS as Record<string, { stepUp: boolean }>)
      .filter(([, access]) => access.stepUp)
      .map(([name]) => name);
    expect(
      Object.keys(counted)
        .filter((name) => name !== 'step-up')
        .sort(),
    ).toEqual(marked.sort());
    for (const kind of Object.values(counted).filter((kind) => kind !== 'no event yet')) {
      expect(SECURITY_KINDS).toContain(kind);
    }
  });

  it('counts every change of the line’s controls, as the action it is, from its before and after alone', () => {
    const changed = (change: object) => countAs({ type: 'controls.changed', change });
    expect(changed({ control: 'autonomy', before: 'supervised', after: 'guarded' })).toEqual({
      kind: 'autonomy-loosened',
    });
    expect(changed({ control: 'autonomy', before: 'guarded', after: 'supervised' })).toEqual({
      kind: 'autonomy-tightened',
    });
    expect(changed({ control: 'new-work', before: true, after: false })).toEqual({ kind: 'new-work-off' });
    expect(changed({ control: 'new-work', before: false, after: true })).toEqual({ kind: 'new-work-on' });
    expect(changed({ control: 'auto-merge', before: false, after: true })).toEqual({ kind: 'auto-merge-on' });
    expect(changed({ control: 'auto-merge', before: true, after: false })).toEqual({ kind: 'auto-merge-off' });
    const one = { kind: 'just-one', workItem: '1290' };
    expect(changed({ control: 'take', before: one, after: { kind: 'every' } })).toEqual({ kind: 'take-widened' });
    expect(changed({ control: 'take', before: { kind: 'every' }, after: one })).toEqual({ kind: 'take-narrowed' });
    expect(changed({ control: 'take', before: null, after: one })).toEqual({ kind: 'take-widened' });
    expect(changed({ control: 'auto-rollback', before: true, after: false })).toBeNull();
    expect(countAs({ type: 'controls.changed' })).toBeNull();
    // A malformed change is counted as nothing, and stops no count.
    expect(changed({ control: 'take', before: one, after: null })).toBeNull();
    expect(changed({ control: 'autonomy', before: 'supervised', after: 'yolo' })).toBeNull();
  });

  it('tells a guardrail by the access table’s list', () => {
    for (const cause of HOLD_CAUSES) {
      const approved = countAs({ type: 'hold.answered', decision: 'approved', cause });
      expect(approved !== null, cause).toBe((GUARDRAIL_HOLDS as readonly string[]).includes(cause));
    }
  });
});
