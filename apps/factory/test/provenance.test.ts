import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { objectives } from '../../../policy/objectives.ts';
import * as query from '../src/alerts/queries.ts';
import { budgetRulesFor, routeRulesFor, rulesFor } from '../src/alerts/rules.ts';
import { Loki } from '../src/clients/loki.ts';
import { Prometheus } from '../src/clients/prometheus.ts';
import { Tempo } from '../src/clients/tempo.ts';
import { signalForDisagreement } from '../src/logs/agreement.ts';
import { Watcher } from '../src/logs/watcher.ts';
import { LOGS_FROM_THE_APP, METRICS_FROM_THE_APP, TRACES_FROM_THE_APP } from '../src/provenance.ts';
import { routeTemplates } from '../src/routes.ts';

/**
 * Any worker may send the collector telemetry that names itself the app. The senses take as the app's only what the
 * collector stamped as from the app's pods: these tests hold the senses' selectors to that, and the collector and the
 * backends to stamping and keeping what the selectors read.
 */

const DEPLOY = fileURLToPath(new URL('../../../deploy/base/telemetry/values/', import.meta.url));
const values = async (file: string) => parse(await readFile(join(DEPLOY, file), 'utf-8'));

/** Every query the senses sent, by backend, through the real clients. */
function recording() {
  const sent = { loki: [] as string[], prometheus: [] as string[], tempo: [] as string[] };
  const answer = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const fetcher = (backend: keyof typeof sent) =>
    (async (input: URL | string | Request) => {
      const url = new URL(String(input));
      sent[backend].push(url.searchParams.get('query') ?? url.searchParams.get('q') ?? '');
      return backend === 'tempo' ? answer({ traces: [] }) : answer({ data: { resultType: 'vector', result: [] } });
    }) as typeof fetch;
  return {
    sent,
    loki: new Loki('http://loki', fetcher('loki')),
    prometheus: new Prometheus('http://prometheus', fetcher('prometheus')),
    tempo: new Tempo('http://tempo', fetcher('tempo')),
  };
}

/** Each of a query's selectors of the app's logs, request metrics or traces, and whether it carries the stamp. */
function selectors(text: string) {
  const logs = [...text.matchAll(/\{service_name=[^}]*\}/g)].map(([s]) => s);
  const metrics = [...text.matchAll(/\{job=[^}]*\}/g)].map(([s]) => s);
  const traces = [...text.matchAll(/\{\s*resource\.service\.name\s*=[^}]*\}/g)].map(([s]) => s);
  return { logs, metrics, traces };
}

function expectStamped(queries: string[]) {
  let seen = 0;
  for (const text of queries) {
    const { logs, metrics, traces } = selectors(text);
    for (const s of logs) expect(s, text).toContain(`, ${LOGS_FROM_THE_APP}}`);
    for (const s of metrics) expect(s, text).toContain(`, ${METRICS_FROM_THE_APP}`);
    for (const s of traces) expect(s, text).toContain(` && ${TRACES_FROM_THE_APP}`);
    seen += logs.length + metrics.length + traces.length;
  }
  expect(seen).toBeGreaterThan(0);
}

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 9, minutes));

describe('the senses read only what the collector stamped as the app’s', () => {
  it('the log watcher, in its errors, reports and agreement of logs, metrics and traces', async () => {
    const { sent, loki, prometheus, tempo } = recording();
    const log = pino({ level: 'silent' });
    const outbox = { send: async () => {} } as never;
    const timing = { settleMs: 0, agreementWindowMs: 5 * 60_000, agreementLagMs: 0, reportLateMs: 0 };
    const watcher = new Watcher(
      { objectives, loki, prometheus, tempo, outbox, log },
      { errors: at(0), reports: at(0) },
      timing,
    );
    await watcher.learnPatterns();
    await watcher.checkErrors(at(10));
    await watcher.checkReports(at(10));
    await watcher.checkAgreement(at(10));
    await routeTemplates(loki, objectives, at(10));
    const entry = { path: '/about', route: '/about', version: 'abc1234', metrics: 30, logs: 30, traces: 2 };
    await signalForDisagreement('wrong-metric', entry, { objectives, prometheus }, at(5), at(10));

    expect(sent.loki.length).toBeGreaterThan(0);
    expect(sent.prometheus.length).toBeGreaterThan(0);
    expect(sent.tempo.length).toBeGreaterThan(0);
    expectStamped(sent.loki);
    expectStamped(sent.prometheus);
    expectStamped(sent.tempo);
  });

  it('the alerting rules, the routes’ and the error budget’s, and the intake’s and Verify’s pictures of a route', () => {
    const scopes = [{}, { route: '/about' }, { template: '/products/:slug' }, { route: '/about', version: 'abc1234' }];
    expectStamped([
      ...rulesFor(objectives).map((rule) => rule.expr),
      ...routeRulesFor(objectives).map((rule) => rule.expr),
      ...budgetRulesFor(objectives).map((rule) => rule.expr),
      ...scopes.flatMap((scope) => [query.requests(objectives, scope), query.errorRatio(objectives, scope)]),
      ...scopes.flatMap((scope) => [query.latency(objectives, scope)]),
      query.versions(objectives, { route: '/about' }),
    ]);
  });

  it('a trace fetched by its id, which anyone may send: only the app’s spans of it', async () => {
    const resource = (attributes: Record<string, string>) => ({
      attributes: Object.entries(attributes).map(([key, value]) => ({ key, value: { stringValue: value } })),
    });
    const batch = (name: string, attributes: Record<string, string>) => ({
      resource: resource(attributes),
      scopeSpans: [{ spans: [{ name, startTimeUnixNano: '1000000000', endTimeUnixNano: '2000000000' }] }],
    });
    const trace = {
      batches: [
        batch('GET /about', { 'service.name': 'website', 'k8s.pod.name': 'website-abc' }),
        batch('planted', { 'service.name': 'website' }),
      ],
    };
    const tempo = new Tempo('http://tempo', (async () => new Response(JSON.stringify(trace))) as typeof fetch);
    expect((await tempo.spans('0af7651916cd43dd8448eb211c80319c'))?.map((s) => s.name)).toEqual(['GET /about']);
    const planted = new Tempo(
      'http://tempo',
      (async () => new Response(JSON.stringify({ batches: trace.batches.slice(1) }))) as typeof fetch,
    );
    expect(await planted.spans('0af7651916cd43dd8448eb211c80319c')).toBeUndefined();
  });

  it('the app’s dashboard', async () => {
    const dashboard = await readFile(join(DEPLOY, '../dashboards/website.json'), 'utf-8');
    const targets = (JSON.parse(dashboard) as { panels: { targets?: { expr?: string; query?: string }[] }[] }).panels
      .flatMap((panel) => panel.targets ?? [])
      .map((target) => target.expr ?? target.query ?? '');
    expectStamped(targets);
  });
});

describe('the collector stamps the app’s records, and the backends keep what the senses read', () => {
  it('stamps only records from pods in `website`, with the pod and the hash the selectors read', async () => {
    const { config } = await values('otel-collector.yaml');
    const k8s = config.processors.k8s_attributes;
    expect(k8s.filter).toEqual({ namespace: 'website' });
    expect(k8s.extract.metadata).toContain('k8s.pod.name');
    expect(k8s.extract.labels.map((l: { tag_name: string }) => l.tag_name)).toContain(
      'k8s.pod.label.rollouts-pod-template-hash',
    );
    // That what a record claims of its pod is deleted before k8s_attributes runs is rollouts.test.ts's.
    for (const pipeline of ['logs', 'metrics', 'traces']) {
      expect(config.service.pipelines[pipeline].processors).toContain('k8s_attributes');
    }
  });

  it('Prometheus makes the hash a label of each series', async () => {
    const { server } = await values('prometheus.yaml');
    expect(server.otlp.promote_resource_attributes).toContain('k8s.pod.label.rollouts-pod-template-hash');
    expect(METRICS_FROM_THE_APP).toMatch(/^k8s_pod_label_rollouts_pod_template_hash!=/);
  });

  it('Loki keeps its own choice of stream labels, which makes `k8s.pod.name` one', async () => {
    const { loki } = await values('loki.yaml');
    // Loki's default for OTLP makes a stream label of a resource's `k8s.pod.name` and of no attribute of a record.
    // Configured otherwise, the stamp could be dropped, or a record's own attribute could reach a stream's labels.
    expect(loki.limits_config.otlp_config).toBeUndefined();
    expect(LOGS_FROM_THE_APP).toMatch(/^k8s_pod_name!=/);
  });

  it('Loki deletes logs by age, and on no one’s request', async () => {
    const { loki } = await values('loki.yaml');
    // Loki applies a retention period only when the compactor's retention is on; without it, it keeps every log.
    expect(loki.limits_config.retention_period).toBe('168h');
    expect(loki.compactor.retention_enabled).toBe(true);
    expect(loki.compactor.delete_request_store).toBe('filesystem');
    // With a delete request store, Loki would take requests to delete logs, from anything that reaches it.
    expect(loki.limits_config.deletion_mode).toBe('disabled');
  });
});
