import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import {
  ARGO_CD_MINUTES,
  CRASH_RESTARTS,
  CRASH_WINDOW,
  factoryRules,
  flagRules,
  KEEP_FIRING,
  LEVELS,
  martinRules,
  RULES_FILE,
  WORKERS,
} from '../src/alerts/rules.ts';
import { TARGETS } from '../src/probes/health.ts';
import { METRICS_FROM_THE_GATEWAY, METRICS_FROM_THE_LINE, METRICS_FROM_THE_PROBES } from '../src/provenance.ts';
import { manifests } from './deploy.ts';

/**
 * The alerts on the factory's health, releases and spend, run by Prometheus's own rule tester (`promtool test rules`,
 * held in mise.toml to the server's minor release) against the rules file as committed: each fires when its cause
 * holds, at its level, and not before, nor for another pod's series; the health alerts go on firing for a while after.
 */
interface Rule {
  alert: string;
  expr: string;
  for?: string;
  keep_firing_for?: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

const committed = () => {
  const values = parse(readFileSync(RULES_FILE, 'utf8')) as {
    serverFiles: { 'alerting_rules.yml': { groups: { name: string; rules: Rule[] }[] } };
  };
  return values.serverFiles['alerting_rules.yml'].groups.filter((group) => group.name === 'factory');
};

/** A series as the named worker's pod sends it, by what the collector stamps on it. */
const from = (stamp: string) => (name: string, labels: string) => `${name}{${labels}, ${stamp}}`;
const line = from(METRICS_FROM_THE_LINE);
const probes = from(METRICS_FROM_THE_PROBES);
const gateway = from(METRICS_FROM_THE_GATEWAY);
/** The same, as another worker's pod would send it. */
const other = from('k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="triage"');

/**
 * What promtool expects of an alert that fires: the rule's labels with the series' own, and its annotations with
 * their labels filled in, as Prometheus expands them.
 */
function firing(name: string, labels: Record<string, string> = {}, which = 0) {
  const rule = factoryRules().filter((r) => r.alert === name)[which];
  if (!rule) throw new Error(`No rule ${name}`);
  const fill = (text: string) => text.replace(/\{\{ \$labels\.(\w+) \}\}/g, (_, label: string) => labels[label] ?? '');
  return {
    exp_labels: { ...labels, ...rule.labels },
    exp_annotations: Object.fromEntries(Object.entries(rule.annotations).map(([k, v]) => [k, fill(v)])),
  };
}

interface Case {
  interval: string;
  input_series: { series: string; values: string }[];
  alert_rule_test: { eval_time: string; alertname: string; exp_alerts: unknown[] }[];
}

/** Runs promtool over the committed rules with these cases, and gives back what it says when any fails. */
function promtool(tests: Case[]): { ok: boolean; output: string } {
  const folder = mkdtempSync(join(tmpdir(), 'factory-alerts-'));
  writeFileSync(join(folder, 'rules.yml'), stringify({ groups: committed() }));
  writeFileSync(
    join(folder, 'tests.yml'),
    stringify({ rule_files: ['rules.yml'], evaluation_interval: '1m', tests }, { lineWidth: 0 }),
  );
  try {
    return {
      ok: true,
      output: execFileSync('promtool', ['test', 'rules', join(folder, 'tests.yml')], { encoding: 'utf-8' }),
    };
  } catch (error) {
    const { stdout = '', stderr = '', message } = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${stdout}${stderr}` || message };
  }
}

/** A value each minute from the first, as promtool's `values` writes them. */
const each = (...values: (number | '_')[]) => values.join(' ');
const expectPasses = ({ ok, output }: { ok: boolean; output: string }) => expect(ok, output).toBe(true);

const CONSOLE = { target: 'console', address: 'http://console' };
const checks = (target: { target: string; address: string }, outcome: string) =>
  `target="${target.target}", address="${target.address}", outcome="${outcome}"`;

describe('the alerts on the factory’s health, releases and spend', () => {
  it('are the rules file’s, generated from the policy, in a group of their own', () => {
    expect(committed().flatMap((group) => group.rules.map((rule) => rule.alert))).toEqual(
      factoryRules().map((rule) => rule.alert),
    );
  });

  it('page for the factory’s health and its spend, and notify of its releases and of Argo CD', () => {
    const level = (alert: string) => [
      ...new Set(
        factoryRules()
          .filter((r) => r.alert === alert)
          .map((r) => r.labels.level),
      ),
    ];
    for (const alert of [
      'ConsoleDown',
      'AppDown',
      'ProbesDown',
      'LineStuck',
      'LeaseOverrun',
      'StoreDown',
      'WorkerCrashLooping',
      'SpendCapReached',
    ]) {
      expect(level(alert), alert).toEqual([LEVELS.page]);
    }
    for (const alert of ['ReleaseRolledBack', 'ReleaseErrored', 'ArgoCDDegraded', 'ArgoCDOutOfSync']) {
      expect(level(alert), alert).toEqual([LEVELS.notify]);
    }
  });

  it('keep the health alerts firing for a while, so a cause that comes and goes pages once, and no security event', () => {
    for (const rule of factoryRules()) {
      const once = ['SpendCapReached', 'ReleaseRolledBack', 'ReleaseErrored'].includes(rule.alert);
      expect(rule.keepFiringFor, rule.alert).toBe(once ? undefined : KEEP_FIRING);
    }
    expect(KEEP_FIRING).toBe('10m');
    for (const rule of [...martinRules(), ...flagRules()]) expect(rule.keepFiringFor, rule.alert).toBeUndefined();
    const text = readFileSync(RULES_FILE, 'utf8');
    expect(text.match(/keep_firing_for: /g)).toHaveLength(factoryRules().filter((r) => r.keepFiringFor).length);
  });

  it('read the line’s, the probes’ and the gateway’s series from their own pods alone', () => {
    const stamps: [RegExp, string][] = [
      [/\bline_\w+(\{[^}]*\})?/g, METRICS_FROM_THE_LINE],
      [/\bprobes_\w+(\{[^}]*\})?/g, METRICS_FROM_THE_PROBES],
      [/\bgateway_\w+(\{[^}]*\})?/g, METRICS_FROM_THE_GATEWAY],
    ];
    let read = 0;
    for (const rule of factoryRules()) {
      for (const [pattern, stamp] of stamps) {
        for (const [selector] of rule.expr.matchAll(pattern)) {
          expect(selector, rule.alert).toContain(stamp);
          expect(selector, rule.alert).not.toMatch(/\b(job|service_name|instance)=/);
          read++;
        }
      }
    }
    expect(read).toBeGreaterThan(8);
  });

  it('name as `worker` only workers deploy/ runs, whose crash loop mutes them', async () => {
    const named = new Set(
      (await manifests())
        .filter(({ manifest, namespace }) => manifest.kind === 'Deployment' && namespace === 'factory')
        .map(({ manifest }) => manifest.metadata?.name),
    );
    for (const worker of Object.values(WORKERS)) expect(named, worker).toContain(worker);
    for (const rule of [...factoryRules(), ...martinRules(), ...flagRules()]) {
      if (rule.labels.worker) expect(Object.values(WORKERS), rule.alert).toContain(rule.labels.worker);
    }
  });

  it('say only what happened, naming no label but an address, a stage, a pod, a cap or an application', () => {
    // Each from the profile's configuration, a closed set, Kubernetes or the repository: never a visitor's words.
    const allowed = ['address', 'stage', 'pod', 'cap', 'name'];
    for (const rule of factoryRules()) {
      const words = `${rule.annotations.summary} ${rule.annotations.description}`;
      for (const [template, label] of words.matchAll(/\{\{ \$labels\.(\w+) \}\}/g)) {
        expect(allowed, `${rule.alert}: ${template}`).toContain(label);
      }
      expect(words.replace(/\{\{ \$labels\.\w+ \}\}/g, ''), rule.alert).not.toContain('{{');
      expect(rule.annotations.description?.length ?? 0, rule.alert).toBeLessThan(600);
    }
  });

  it('page when the console stops answering the probes, and go on firing ten minutes after it answers again', () => {
    expect(TARGETS).toEqual(['console', 'app']);
    const down = firing('ConsoleDown', { address: CONSOLE.address });
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            // Answering, then not for six minutes, then again.
            {
              series: probes('probes_checks_total', checks(CONSOLE, 'answered')),
              values: each(0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20),
            },
            {
              series: probes('probes_checks_total', checks(CONSOLE, 'failed')),
              values: each(0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6),
            },
          ],
          alert_rule_test: [
            { eval_time: '4m', alertname: 'ConsoleDown', exp_alerts: [] },
            { eval_time: '5m', alertname: 'ConsoleDown', exp_alerts: [down] },
            // Answering again from 10m: still firing for ten minutes after the condition last held.
            { eval_time: '15m', alertname: 'ConsoleDown', exp_alerts: [down] },
            { eval_time: '23m', alertname: 'ConsoleDown', exp_alerts: [] },
          ],
        },
        {
          interval: '1m',
          // Another worker's series saying the console fails, beside the probes' saying it answers: nothing.
          input_series: [
            {
              series: probes('probes_checks_total', checks(CONSOLE, 'answered')),
              values: each(0, 1, 2, 3, 4, 5, 6, 7),
            },
            { series: probes('probes_checks_total', checks(CONSOLE, 'failed')), values: each(0, 0, 0, 0, 0, 0, 0, 0) },
            { series: other('probes_checks_total', checks(CONSOLE, 'answered')), values: each(0, 0, 0, 0, 0, 0, 0, 0) },
            { series: other('probes_checks_total', checks(CONSOLE, 'failed')), values: each(0, 1, 2, 3, 4, 5, 6, 7) },
          ],
          alert_rule_test: [{ eval_time: '7m', alertname: 'ConsoleDown', exp_alerts: [] }],
        },
      ]),
    );
  });

  it('page when the app stops answering, by each address the profile names', () => {
    const app = { target: 'app', address: 'http://website.website' };
    const pub = { target: 'app', address: 'https://shop.example' };
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            { series: probes('probes_checks_total', checks(app, 'answered')), values: each(0, 1, 2, 3, 4, 5, 6) },
            { series: probes('probes_checks_total', checks(app, 'failed')), values: each(0, 0, 0, 0, 0, 0, 0) },
            { series: probes('probes_checks_total', checks(pub, 'answered')), values: each(0, 0, 0, 0, 0, 0, 0) },
            { series: probes('probes_checks_total', checks(pub, 'failed')), values: each(0, 1, 2, 3, 4, 5, 6) },
          ],
          alert_rule_test: [
            { eval_time: '5m', alertname: 'AppDown', exp_alerts: [firing('AppDown', { address: pub.address })] },
            { eval_time: '5m', alertname: 'ConsoleDown', exp_alerts: [] },
          ],
        },
      ]),
    );
  });

  it('page when the probes report nothing, or count no check, and not while they count', () => {
    const counting = probes('probes_checks_total', checks(CONSOLE, 'answered'));
    const absent = {
      exp_labels: {
        k8s_namespace_name: 'factory',
        k8s_pod_label_app_kubernetes_io_name: 'probes',
        ...firing('ProbesDown').exp_labels,
      },
      exp_annotations: firing('ProbesDown').exp_annotations,
    };
    expectPasses(
      promtool([
        {
          interval: '1m',
          // No series at all.
          input_series: [
            { series: other('probes_checks_total', checks(CONSOLE, 'answered')), values: each(0, 1, 2, 3) },
          ],
          alert_rule_test: [
            { eval_time: '1m', alertname: 'ProbesDown', exp_alerts: [] },
            { eval_time: '2m', alertname: 'ProbesDown', exp_alerts: [absent] },
          ],
        },
        {
          interval: '1m',
          // There, and counting nothing from 3m: five minutes on, and two more.
          input_series: [{ series: counting, values: each(0, 4, 8, 12, 12, 12, 12, 12, 12, 12) }],
          alert_rule_test: [
            { eval_time: '8m', alertname: 'ProbesDown', exp_alerts: [] },
            { eval_time: '9m', alertname: 'ProbesDown', exp_alerts: [firing('ProbesDown')] },
          ],
        },
        {
          interval: '1m',
          input_series: [{ series: counting, values: each(0, 4, 8, 12, 16, 20, 24, 28, 32) }],
          alert_rule_test: [{ eval_time: '8m', alertname: 'ProbesDown', exp_alerts: [] }],
        },
      ]),
    );
  });

  it('page when the line carries a work item past its stage’s limit in force, and not for a stage with none', () => {
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            { series: line('line_taken_oldest_seconds', 'stage="gates"'), values: each(3480, 3540, 3600, 3660, 3720) },
            { series: line('line_taken_limit_seconds', 'stage="gates"'), values: each(3600, 3600, 3600, 3600, 3600) },
            // Held for Martin has no limit, however long.
            { series: line('line_taken_oldest_seconds', 'stage="held"'), values: each(1e6, 1e6, 1e6, 1e6, 1e6) },
          ],
          alert_rule_test: [
            { eval_time: '2m', alertname: 'LineStuck', exp_alerts: [] },
            { eval_time: '3m', alertname: 'LineStuck', exp_alerts: [firing('LineStuck', { stage: 'gates' })] },
          ],
        },
        {
          interval: '1m',
          // The line told to stop reads none: no page, once the keep-firing has passed for one that was.
          input_series: [
            { series: line('line_taken_oldest_seconds', 'stage="build"'), values: each(7300, 0, 0, 0) },
            { series: line('line_taken_limit_seconds', 'stage="build"'), values: each(7200, 7200, 7200, 7200) },
            // Another worker's figures never page.
            { series: other('line_taken_oldest_seconds', 'stage="plan"'), values: each(9e9, 9e9, 9e9, 9e9) },
            { series: other('line_taken_limit_seconds', 'stage="plan"'), values: each(1, 1, 1, 1) },
          ],
          alert_rule_test: [
            { eval_time: '0m', alertname: 'LineStuck', exp_alerts: [firing('LineStuck', { stage: 'build' })] },
            { eval_time: '3m', alertname: 'LineStuck', exp_alerts: [firing('LineStuck', { stage: 'build' })] },
          ],
        },
      ]),
    );
  });

  it('page when a lease has been held five minutes past its expiry', () => {
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [{ series: line('line_lease_overrun_seconds', 'x="1"'), values: each(0, 0, 120, 240, 360) }],
          alert_rule_test: [
            { eval_time: '3m', alertname: 'LeaseOverrun', exp_alerts: [] },
            { eval_time: '4m', alertname: 'LeaseOverrun', exp_alerts: [firing('LeaseOverrun')] },
          ],
        },
      ]),
    );
  });

  it('page when the store stops answering, whatever another series says, or nothing says', () => {
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            { series: 'pg_up{job="kubernetes-pods", pod="postgres-exporter-1"}', values: each(1, 1, 0, 0, 0) },
            { series: 'pg_up{job="triage"}', values: each(1, 1, 1, 1, 1) },
          ],
          alert_rule_test: [
            { eval_time: '2m', alertname: 'StoreDown', exp_alerts: [] },
            { eval_time: '3m', alertname: 'StoreDown', exp_alerts: [firing('StoreDown')] },
          ],
        },
        {
          interval: '1m',
          input_series: [{ series: 'up{job="kubernetes-pods"}', values: each(1, 1, 1, 1, 1, 1) }],
          alert_rule_test: [
            { eval_time: '4m', alertname: 'StoreDown', exp_alerts: [] },
            { eval_time: '5m', alertname: 'StoreDown', exp_alerts: [firing('StoreDown', {}, 1)] },
          ],
        },
      ]),
    );
  });

  it('page within minutes of a crash loop in factory, naming its worker, and not for one restart or one elsewhere', () => {
    expect([CRASH_RESTARTS, CRASH_WINDOW]).toEqual([3, '5m']);
    const restarts = (namespace: string, pod: string) =>
      `kube_pod_container_status_restarts_total{namespace="${namespace}", pod="${pod}", container="c"}`;
    const pod = 'triage-7d9f8b6c4-x2b7q';
    // Kubernetes' back-off from the first crash: restarts 10 s, 30 s, 70 s and 150 s in, then 310 s, read every 30 s.
    // The waiting reason would clear at each, and a `for` on it would only hold once the back-off outgrew it.
    const looping = each(0, 2, 2, 3, 3, 4, 4, 4, 4, 4, 5, 5);
    expectPasses(
      promtool([
        {
          interval: '30s',
          input_series: [
            { series: restarts('factory', pod), values: looping },
            { series: restarts('website', 'website-5c8d7b9f4-abcde'), values: looping },
            // A StatefulSet's pod has no worker's name to take.
            { series: restarts('factory', 'postgres-0'), values: looping },
            // One restart is not a loop.
            { series: restarts('factory', 'line-6b5c4d3e2-qwert'), values: each(0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1) },
          ],
          alert_rule_test: [
            { eval_time: '1m', alertname: 'WorkerCrashLooping', exp_alerts: [] },
            {
              eval_time: '2m',
              alertname: 'WorkerCrashLooping',
              exp_alerts: [
                firing('WorkerCrashLooping', { pod: 'postgres-0' }),
                firing('WorkerCrashLooping', { pod, worker: 'triage' }),
              ],
            },
            // Still within the five minutes, and then kept firing past them.
            {
              eval_time: '5m',
              alertname: 'WorkerCrashLooping',
              exp_alerts: [
                firing('WorkerCrashLooping', { pod: 'postgres-0' }),
                firing('WorkerCrashLooping', { pod, worker: 'triage' }),
              ],
            },
          ],
        },
      ]),
    );
  });

  it('page when the day’s or the month’s cap is reached, by the gateway’s figures alone', () => {
    const cap = (c: string) => `cap="${c}", profile="local"`;
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            { series: gateway('gateway_cap_spent_usd', cap('day')), values: each(19.5, 20, 20) },
            { series: gateway('gateway_cap_limit_usd', cap('day')), values: each(20, 20, 20) },
            { series: gateway('gateway_cap_spent_usd', cap('month')), values: each(50, 50, 50) },
            { series: gateway('gateway_cap_limit_usd', cap('month')), values: each(100, 100, 100) },
            // A work item's cap is the line's to hold for, not a page.
            { series: gateway('gateway_cap_limit_usd', cap('work-item')), values: each(0, 0, 0) },
          ],
          alert_rule_test: [
            { eval_time: '0m', alertname: 'SpendCapReached', exp_alerts: [] },
            { eval_time: '1m', alertname: 'SpendCapReached', exp_alerts: [firing('SpendCapReached', { cap: 'day' })] },
          ],
        },
        {
          interval: '1m',
          input_series: [
            { series: other('gateway_cap_spent_usd', cap('day')), values: each(99, 99) },
            { series: gateway('gateway_cap_limit_usd', cap('day')), values: each(20, 20) },
          ],
          alert_rule_test: [{ eval_time: '1m', alertname: 'SpendCapReached', exp_alerts: [] }],
        },
      ]),
    );
  });

  it('notify of a release rolled back, aborted or in error, once, and of no dry run’s', () => {
    const ended = (outcome: string, dryRun = false) =>
      line('line_releases_total', `outcome="${outcome}", dry_run="${dryRun}"`);
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            { series: ended('rolled-back'), values: each(0, 0, 1, 1, 1, 1, 1, 1, 1, 1) },
            { series: ended('aborted'), values: each(0, 0, 0, 1, 1, 1, 1, 1, 1, 1) },
            { series: ended('errored'), values: each(0, 1, 1, 1, 1, 1, 1, 1, 1, 1) },
            { series: ended('rolled-back', true), values: each(0, 1, 2, 3, 4, 5, 6, 7, 8, 9) },
            { series: ended('errored', true), values: each(0, 1, 2, 3, 4, 5, 6, 7, 8, 9) },
          ],
          alert_rule_test: [
            { eval_time: '1m', alertname: 'ReleaseRolledBack', exp_alerts: [] },
            {
              eval_time: '3m',
              alertname: 'ReleaseRolledBack',
              exp_alerts: [
                firing('ReleaseRolledBack', { outcome: 'rolled-back' }),
                firing('ReleaseRolledBack', { outcome: 'aborted' }, 1),
              ],
            },
            {
              eval_time: '1m',
              alertname: 'ReleaseErrored',
              exp_alerts: [firing('ReleaseErrored', { outcome: 'errored' })],
            },
            // Five minutes on, nothing new: resolved, and never sent again.
            { eval_time: '9m', alertname: 'ReleaseRolledBack', exp_alerts: [] },
            { eval_time: '9m', alertname: 'ReleaseErrored', exp_alerts: [] },
          ],
        },
      ]),
    );
  });

  it(`notify when an Argo CD application stays Degraded or OutOfSync for ${ARGO_CD_MINUTES} minutes`, () => {
    const app = (health: string, sync: string) =>
      `argocd_app_info{name="root", namespace="argocd", health_status="${health}", sync_status="${sync}"}`;
    const minutes = (n: number, value: number) => Array.from({ length: n }, () => value);
    expectPasses(
      promtool([
        {
          interval: '1m',
          input_series: [
            { series: app('Degraded', 'OutOfSync'), values: each(...minutes(40, 1)) },
            { series: app('Healthy', 'Synced'), values: each(...minutes(40, 0)) },
          ],
          alert_rule_test: [
            { eval_time: `${ARGO_CD_MINUTES - 1}m`, alertname: 'ArgoCDDegraded', exp_alerts: [] },
            {
              eval_time: `${ARGO_CD_MINUTES}m`,
              alertname: 'ArgoCDDegraded',
              exp_alerts: [firing('ArgoCDDegraded', { name: 'root' })],
            },
            {
              eval_time: `${ARGO_CD_MINUTES}m`,
              alertname: 'ArgoCDOutOfSync',
              exp_alerts: [firing('ArgoCDOutOfSync', { name: 'root' })],
            },
          ],
        },
      ]),
    );
  });
});
