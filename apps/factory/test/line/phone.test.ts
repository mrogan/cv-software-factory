/**
 * Whether alerts reach Martin's phone, as the line reads it from the store (line/phone.ts), collected as an
 * OpenTelemetry SDK collects it: a meter provider is installed for this file before the module loads.
 */
import { metrics as api } from '@opentelemetry/api';
import * as metrics from '@opentelemetry/sdk-metrics';
import { VERSIONS } from '@software-factory/events';
import pino from 'pino';
import type { Sql } from 'postgres';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { Profile } from '../../../../policy/spend.ts';

const reader = new metrics.PeriodicExportingMetricReader({
  exporter: new metrics.InMemoryMetricExporter(metrics.AggregationTemporality.CUMULATIVE),
  exportIntervalMillis: 3_600_000,
});
const meterProvider = new metrics.MeterProvider({ readers: [reader] });
api.setGlobalMeterProvider(meterProvider);
const { observePhone } = await import('../../src/line/phone.ts');

afterAll(async () => {
  await meterProvider.shutdown();
  api.disable();
});

let database: Database;
beforeEach(async () => {
  database = await freshDatabase('line_phone');
});
afterEach(() => database?.end());

/** The series as the SDK collects it now. */
async function phone(sql: Sql, profile: Profile): Promise<number | undefined> {
  const stop = observePhone(sql, profile, pino({ level: 'silent' }));
  try {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .find((m) => m.descriptor.name === 'line.alerts.phone');
    return metric?.dataPoints.at(-1)?.value as number | undefined;
  } finally {
    stop();
  }
}

/** A switch as Martin's command line's role stores it. */
const stored = (phone: boolean) =>
  database.operator`
    insert into events (id, ts, work_item, type, version, actor, summary, payload, artifacts, public, sample)
    values (${crypto.randomUUID()}, now(), null, 'alerts.switched', ${VERSIONS['alerts.switched']}, 'martin',
            'alerts.switched', ${database.operator.json({ phone })}, '[]', '{}', false)`;

describe('the line’s series of whether alerts reach the phone', () => {
  it('says the profile’s default before any switch, and Martin’s latest switch after, as the line reads it', async () => {
    expect(await phone(database.as.line, 'local')).toBe(0);
    expect(await phone(database.as.line, 'do')).toBe(1);
    await stored(true);
    expect(await phone(database.as.line, 'local')).toBe(1);
    await stored(false);
    expect(await phone(database.as.line, 'aws')).toBe(0);
  });
});
