import { createServer } from 'node:net';
import { metrics } from '@opentelemetry/api';
import { type DataPoint, type Histogram, MeterProvider, MetricReader } from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { connect } from '../src/client.ts';

// Collected on demand, as Prometheus would scrape them.
class Reader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}
const reader = new Reader();

beforeAll(() => {
  metrics.setGlobalMeterProvider(new MeterProvider({ readers: [reader] }));
});
afterAll(() => {
  metrics.disable();
});

async function series(name: string): Promise<DataPoint<number | Histogram>[]> {
  const { resourceMetrics } = await reader.collect();
  const found = resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics).find((m) => m.descriptor.name === name);
  return (found?.dataPoints ?? []) as DataPoint<number | Histogram>[];
}
const count = (point: DataPoint<number | Histogram> | undefined) =>
  typeof point?.value === 'number' ? point.value : (point?.value.count ?? 0);
const find = (points: DataPoint<number | Histogram>[], attributes: Record<string, string>) =>
  points.find((p) => JSON.stringify(p.attributes) === JSON.stringify(attributes));

describe("the store's client", () => {
  it('times each query by its first word and how it ended, and holds no text of it', async () => {
    const sql = connect(inject('databaseUrl'), { max: 1 });
    try {
      const secret = 'a visitor wrote this';
      await sql`select ${secret}::text as said`;
      await sql`select ${sql`1`} as fragment`;
      await sql.begin((tx) => tx`select 1`);
      // A cursor settles the query through what it puts in place of the query's own answer.
      const batches = [];
      for await (const rows of sql`select generate_series(1, 5)`.cursor(2)) batches.push(rows.length);
      expect(batches).toEqual([2, 2, 1]);
      await expect(sql`select 1 / 0`).rejects.toThrow(/division by zero/);
      await expect(sql.unsafe('selec nothing')).rejects.toThrow();

      const points = await series('store.query.duration');
      // Four selects, the transaction's and the cursor's included, and postgres.js's own of the server's array types as it first
      // connects; a fragment inside another query is never a query of its own.
      expect(count(find(points, { operation: 'select', outcome: 'ok' }))).toBe(5);
      expect(count(find(points, { operation: 'begin', outcome: 'ok' }))).toBe(1);
      expect(count(find(points, { operation: 'commit', outcome: 'ok' }))).toBe(1);
      expect(count(find(points, { operation: 'select', outcome: 'error', code: '22012' }))).toBe(1);
      expect(count(find(points, { operation: 'other', outcome: 'error', code: '42601' }))).toBe(1);
      const attributes = JSON.stringify(points.map((p) => p.attributes));
      expect(attributes).not.toContain(secret);
      expect(attributes).not.toMatch(/division|selec |::text/);
    } finally {
      await sql.end();
    }
  });

  it('counts the connections it holds open, and each it opened', async () => {
    const before = count(find(await series('store.connection.attempts'), { outcome: 'connected' }));
    const sql = connect(inject('databaseUrl'), { max: 2 });
    try {
      await Promise.all([sql`select pg_sleep(0.05)`, sql`select pg_sleep(0.05)`]);
      expect(count((await series('store.connections'))[0])).toBe(2);
      expect(count(find(await series('store.connection.attempts'), { outcome: 'connected' }))).toBe(before + 2);
    } finally {
      await sql.end();
    }
    expect(count((await series('store.connections'))[0])).toBe(0);
  });

  it('counts a connection that never opened, and the query that waited for it fails with its code', async () => {
    // A port that was free a moment ago, and that nothing listens on.
    const server = createServer().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as { port: number };
    await new Promise((resolve) => server.close(resolve));

    const sql = connect(`postgres://nobody:nothing@127.0.0.1:${port}/none`, { max: 1, connect_timeout: 2 });
    try {
      await expect(sql`select 1`).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      // The socket closes just after its error fails the query.
      await vi.waitFor(async () =>
        expect(count(find(await series('store.connection.attempts'), { outcome: 'failed' }))).toBe(1),
      );
      expect(
        count(
          find(await series('store.query.duration'), { operation: 'select', outcome: 'error', code: 'ECONNREFUSED' }),
        ),
      ).toBe(1);
      expect(count((await series('store.connections'))[0])).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
