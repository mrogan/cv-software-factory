/**
 * Whether alerts reach Martin's phone, as the admin service tells Prometheus (admin/phone.ts), collected as an
 * OpenTelemetry SDK collects it: a meter provider is installed for this file before the module loads, as `telemetry.ts`
 * is before the service's.
 */
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { VERSIONS } from '@software-factory/events';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { PHONE_DEFAULT, phoneInForce } from '../../../../policy/phone.ts';
import type { Profile } from '../../../../policy/spend.ts';
import { AdminStore, type Session } from '../../src/admin/store.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
const { observePhone, switchPhone } = await import('../../src/admin/phone.ts');

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('admin_phone');
});
afterEach(() => database?.end());

const quiet = pino({ level: 'silent' });

/** The series as the SDK collects it now, or undefined when nothing was observed. */
async function phone(sql: Sql, profile: Profile): Promise<number | undefined> {
  const stop = observePhone(sql, profile, quiet);
  try {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((m) => m.descriptor.name === 'admin.alerts.phone');
    return metric?.dataPoints.at(-1)?.value as number | undefined;
  } finally {
    stop();
  }
}

/** A switch as Martin's command line's role stores it. */
const stored = (phone: unknown) =>
  database.operator`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), null, 'alerts.switched', ${VERSIONS['alerts.switched']}, 'martin',
            'alerts.switched', ${database.operator.json({ phone } as never)}, '[]', '{}', false)`;

describe('whether alerts reach the phone, in force', () => {
  it('is off on the laptop and on in the cloud until Martin switches it, and his switch after', () => {
    expect(PHONE_DEFAULT).toEqual({ local: false, do: true, aws: true });
    expect(phoneInForce('local')).toBe(false);
    expect(phoneInForce('do', { phone: false })).toBe(false);
    expect(phoneInForce('local', { phone: true })).toBe(true);
    // Anything but a yes or no is not in force: the profile's default is.
    expect(phoneInForce('aws', { phone: 'off' })).toBe(true);
    expect(phoneInForce('local', null)).toBe(false);
  });
});

describe('the admin service’s series of it', () => {
  it('says the profile’s default before any switch, and the latest switch after', async () => {
    expect(await phone(database.admin, 'local')).toBe(0);
    expect(await phone(database.admin, 'do')).toBe(1);
    await stored(true);
    expect(await phone(database.admin, 'local')).toBe(1);
    await stored(false);
    expect(await phone(database.admin, 'aws')).toBe(0);
  });

  it('goes on saying the switch it last read while it cannot read the store, rather than the default', async () => {
    await stored(true);
    expect(await phone(database.admin, 'local')).toBe(1);
    const closed = (await freshDatabase('admin_phone_closed')).admin;
    await closed.end();
    // Nothing new is observed: the SDK sends the last it had, and the laptop's default, off, is not read into it.
    expect(await phone(closed, 'local')).toBe(1);
  });
});

describe('a switch', () => {
  // The passkey is asked for only to switch them off, and these switch nothing off: no session is read.
  const session = { hash: 'none' } as unknown as Session;

  it('to what the profile’s default already is records nothing', async () => {
    const store = new AdminStore(database.admin);
    expect(await switchPhone(store, 'local', session, { phone: false })).toEqual({ phone: false, changed: false });
    expect(await switchPhone(store, 'do', session, { phone: true })).toEqual({ phone: true, changed: false });
    expect(await database.owner`select 1 from events where type = 'alerts.switched'`).toHaveLength(0);
  });

  it('on, from the laptop’s default, is recorded as Martin’s', async () => {
    const store = new AdminStore(database.admin);
    expect(await switchPhone(store, 'local', session, { phone: true })).toEqual({ phone: true, changed: true });
    expect(await database.owner`select appended_by, payload from events where type = 'alerts.switched'`).toEqual([
      { appended_by: 'factory_admin', payload: { phone: true } },
    ]);
    expect(await phone(database.admin, 'local')).toBe(1);
  });
});
