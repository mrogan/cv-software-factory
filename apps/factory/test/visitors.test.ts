/**
 * Nothing the collector keeps says who a visitor is: it deletes every address of the client or peer a span or log
 * record names, and the browser's whole user agent, keeping of the browser only its family, major version, operating
 * system and device class, and counts the app's and the console's requests by them (values/otel-collector.yaml).
 *
 * The OTTL itself runs in the collector alone. Run against the collector at the chart's version, these statements turn
 * Chrome 141 on a Mac into `Chrome`, `141`, `macOS`, `desktop`, and Safari on an iPhone into `Safari`, `18`, `iOS`,
 * `mobile` (the pull request that brought them shows the run); this holds the configuration to its parts.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const VALUES = fileURLToPath(new URL('../../../deploy/base/telemetry/values/otel-collector.yaml', import.meta.url));

interface Statements {
  statements: string[];
}
interface Collector {
  config: {
    processors: Record<
      string,
      { trace_statements?: Statements[]; log_statements?: Statements[]; metric_statements?: Statements[] }
    >;
    connectors: Record<string, { spans?: Record<string, { conditions: string[]; attributes: { key: string }[] }> }>;
    service: { pipelines: Record<string, { receivers: string[]; processors: string[]; exporters: string[] }> };
  };
}

const collector = async () => parse(await readFile(VALUES, 'utf-8')) as Collector;

/**
 * Where OpenTelemetry's HTTP instrumentation, in either of its conventions, and a sender capturing the proxy's headers,
 * put a client's address or its browser's user agent.
 */
const PERSONAL = [
  'client.address',
  'client.port',
  'network.peer.address',
  'network.peer.port',
  'net.peer.ip',
  'net.peer.port',
  'net.peer.name',
  'net.sock.peer.addr',
  'net.sock.peer.port',
  'http.client_ip',
  'http.request.header.x-forwarded-for',
  'http.request.header.x-real-ip',
  'http.request.header.forwarded',
  'http.request.header.user-agent',
  'http.request.header.cookie',
  // What only the collector sets, and only on spans: a log record keeps no browser.
  'browser.name',
  'browser.major',
  'os.name',
  'device.type',
  'traffic',
  'user_agent.original',
  'http.user_agent',
];

/** What the instrumentation records of the server, which the service graph names a node by: never deleted. */
const KEPT = ['server.address', 'server.port', 'http.route', 'url.path', 'http.response.status_code'];

/** The patterns `delete_matching_keys` deletes by, from the attributes of a record in `context`. */
function deletes(statements: Statements[] | undefined, context: 'span' | 'log'): RegExp[] {
  const pattern = new RegExp(`^delete_matching_keys\\(${context}\\.attributes, "(.+)"\\)$`);
  return (statements ?? [])
    .flatMap((group) => group.statements)
    .flatMap((statement) => {
      const match = pattern.exec(statement);
      // The YAML keeps OTTL's own escapes: `\\.` in the file is `\.` to Go's regular expressions.
      return match?.[1] ? [new RegExp(match[1].replaceAll('\\\\', '\\'))] : [];
    });
}

describe('the collector keeps nothing that says who a visitor is', () => {
  it('deletes every address and the user agent from spans and log records', async () => {
    const { config } = await collector();
    const visitors = config.processors['transform/visitors'];
    for (const [context, statements] of [
      ['span', visitors?.trace_statements],
      ['log', visitors?.log_statements],
    ] as const) {
      const patterns = deletes(statements, context);
      for (const key of PERSONAL) {
        expect(
          patterns.some((p) => p.test(key)),
          `${context}: ${key} deleted`,
        ).toBe(true);
      }
      for (const key of KEPT) {
        expect(
          patterns.some((p) => p.test(key)),
          `${context}: ${key} kept`,
        ).toBe(false);
      }
    }
  });

  it('deletes them after k8s_attributes, before anything is sent or counted', async () => {
    const { config } = await collector();
    for (const name of ['traces', 'logs']) {
      const processors: string[] = config.service.pipelines[name]?.processors ?? [];
      const exporters: string[] = config.service.pipelines[name]?.exporters ?? [];
      expect(processors.indexOf('transform/visitors'), name).toBeGreaterThan(processors.indexOf('k8s_attributes'));
      expect(processors.indexOf('transform/visitors'), name).toBe(processors.length - 2);
      expect(processors.at(-1), name).toBe('batch');
      expect(exporters.length).toBeGreaterThan(0);
    }
    // The metrics carry neither: the request metrics' attributes are the route, the method and the status.
    expect(config.service.pipelines.metrics?.processors).not.toContain('transform/visitors');
  });

  it('keeps of the browser its family, major version, system and device class, from the user agent alone', async () => {
    const { config } = await collector();
    const statements = config.processors['transform/visitors']?.trace_statements?.flatMap((g) => g.statements) ?? [];
    const set = new Set(
      statements.flatMap((s) => /^set\(span\.attributes\["([^"]+)"\]/.exec(s)?.[1] ?? []).filter(Boolean),
    );
    expect([...set].sort()).toEqual(['browser.major', 'browser.name', 'device.type', 'os.name', 'traffic']);
    // A sender's own values of them go first, and only a server span's agent is read.
    expect(statements[0]).toBe(
      'delete_matching_keys(span.attributes, "^(browser\\\\.(name|major)|os\\\\.name|device\\\\.type|traffic)$")',
    );
    expect(statements.filter((s) => s.startsWith('set(span.cache["agent"]'))).toEqual([
      'set(span.cache["agent"], span.attributes["user_agent.original"]) where span.kind == SPAN_KIND_SERVER',
      'set(span.cache["agent"], span.attributes["http.user_agent"]) where span.kind == SPAN_KIND_SERVER and span.cache["agent"] == nil',
    ]);
    // Each value is one of a few, set in the file; only the major version is read from the agent, and only digits.
    const values = new Set(
      statements.flatMap((s) => /^set\(span\.attributes\["[^"]+"\], "([^"]+)"\)/.exec(s)?.[1] ?? []),
    );
    expect([...values].sort()).toEqual(
      [
        'Android',
        'Chrome',
        'ChromeOS',
        'Edge',
        'Firefox',
        'Linux',
        'Safari',
        'Windows',
        'desktop',
        'factory',
        'iOS',
        'macOS',
        'mobile',
        'other',
        'visitor',
      ].sort(),
    );
    expect(statements.filter((s) => s.includes('browser.major"], ExtractPatterns('))).toHaveLength(1);
    expect(statements.find((s) => s.includes('browser.major"], ExtractPatterns('))).toContain(
      '"^(?P<major>[0-9]{1,4})"',
    );
    // The traffic generator names itself (apps/factory/src/traffic/traffic.ts).
    const traffic = await readFile(new URL('../src/traffic/traffic.ts', import.meta.url), 'utf-8');
    expect(traffic).toContain("'user-agent': 'software-factory-traffic'");
    expect(statements).toContain(
      'set(span.attributes["traffic"], "factory") where span.cache["agent"] == "software-factory-traffic"',
    );
    // The parsed agent is kept in the span's cache, which is never sent.
    expect(statements.some((s) => /^set\(span\.attributes\[[^\]]+\], UserAgent\(/.test(s))).toBe(false);
  });

  it('counts the app’s and the console’s requests from browsers in Prometheus, by family, system, device and source', async () => {
    const { config } = await collector();
    const count = config.connectors['count/browsers']?.spans?.['http.server.browser.requests'];
    expect(count?.attributes.map((a) => a.key)).toEqual(['browser.name', 'os.name', 'device.type', 'traffic']);
    expect(count?.conditions).toEqual([
      'span.kind == SPAN_KIND_SERVER and span.attributes["browser.name"] != nil and (resource.attributes["service.name"] == "website" or resource.attributes["service.name"] == "console")',
    ]);
    const { traces, 'metrics/browsers': browsers } = config.service.pipelines;
    expect(traces?.exporters).toContain('count/browsers');
    expect(browsers).toEqual({
      receivers: ['count/browsers'],
      processors: ['memory_limiter', 'transform/browser-count-now', 'delta_to_cumulative', 'batch'],
      exporters: ['otlp_http/prometheus'],
    });
  });
});
