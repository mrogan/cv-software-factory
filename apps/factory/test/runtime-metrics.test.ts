/**
 * Each worker's own health, as `telemetry.ts` reports it: a process started with it, and its metrics read from the
 * SDK's Prometheus exporter in place of the collector. The console's `telemetry.ts` reports the same.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const telemetry = {
  worker: fileURLToPath(new URL('../src/telemetry.ts', import.meta.url)),
  console: fileURLToPath(new URL('../../console/src/telemetry.ts', import.meta.url)),
};

/** The labels the runtime's series may carry: each has a few values, so a series' count stays bounded. */
const RUNTIME_LABELS = new Set([
  'v8js_heap_space_name',
  'v8js_gc_type',
  'nodejs_eventloop_state',
  'v8js_resource_type',
  'le',
  'otel_scope_name',
  'otel_scope_version',
  'otel_scope_schema_url',
]);

let child: ChildProcess | undefined;
afterEach(() => {
  child?.kill();
  child = undefined;
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** The runtime's series every process reports. A collection's pause is a histogram, recorded only once one has. */
const RUNTIME_SERIES = [
  'v8js_memory_heap_used',
  'v8js_memory_heap_space_size',
  'v8js_memory_heap_space_physical_size',
  'nodejs_eventloop_delay_p99',
  'nodejs_eventloop_utilization',
  'nodejs_eventloop_time_total',
];

/**
 * Starts a process that idles with `telemetry.ts` loaded, and reads its metrics once each of the runtime's is there:
 * the event loop's delay has none until it has been sampled, which on a busy machine can take a scrape or two.
 */
async function metricsOf(module: string): Promise<string> {
  const port = await freePort();
  child = spawn(process.execPath, ['--import', module, '-e', 'setInterval(() => {}, 1000)'], {
    env: {
      ...process.env,
      OTEL_METRICS_EXPORTER: 'prometheus',
      OTEL_EXPORTER_PROMETHEUS_HOST: '127.0.0.1',
      OTEL_EXPORTER_PROMETHEUS_PORT: String(port),
      OTEL_TRACES_EXPORTER: 'none',
      OTEL_LOGS_EXPORTER: 'none',
    },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 15_000;
  let text = '';
  while (Date.now() < deadline) {
    text = await fetch(`http://127.0.0.1:${port}/metrics`)
      .then((response) => response.text())
      .catch(() => '');
    const names = new Set(series(text).map((each) => each.name));
    if (RUNTIME_SERIES.every((name) => names.has(name))) return text;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return text;
}

/** Each series' name and its labels' names, from Prometheus's text format. */
function series(text: string): { name: string; labels: string[] }[] {
  return text
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const [, name = '', labels = ''] = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? /.exec(line) ?? [];
      return { name, labels: [...labels.matchAll(/(\w+)="/g)].map((match) => match[1] ?? '') };
    });
}

describe.each(Object.entries(telemetry))('the %s’s telemetry', (_, module) => {
  it('reports its heap, its event loop and its garbage collection, by the runtime’s own few labels', async () => {
    const all = series(await metricsOf(module)).filter((each) => each.name !== 'target_info');
    const names = new Set(all.map((each) => each.name));

    for (const name of RUNTIME_SERIES) expect(names, name).toContain(name);
    expect(all.flatMap((each) => each.labels).filter((label) => !RUNTIME_LABELS.has(label))).toEqual([]);
  }, 20_000);
});
