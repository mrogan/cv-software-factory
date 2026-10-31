import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments, stringify } from 'yaml';
import { release } from '../../../policy/release.ts';
import { PUSHED_FRESH } from '../src/alerts/rules.ts';
import { METRICS_FROM_THE_ADMIN_SERVICE, METRICS_FROM_THE_LINE } from '../src/provenance.ts';
import {
  conditions,
  ingressServiceOf,
  outOfDate,
  queries,
  render,
  SWITCH_FRESH,
  switched,
  TEMPLATES,
  TEMPLATES_FILE,
  templatesFor,
} from '../src/release/analysis.ts';

interface Metric {
  name: string;
  interval?: string;
  initialDelay?: string;
  successCondition?: string;
  failureCondition?: string;
  failureLimit?: number;
  inconclusiveLimit?: number;
  provider: {
    prometheus?: { query: string };
    job?: { spec: { template: { spec: { containers: { image: string; args: string[] }[] } } } };
  };
}

const metricsOf = (name: string): Metric[] => {
  const template = templatesFor(release).find((t) => t.metadata.name === name);
  if (!template) throw new Error(`no template ${name}`);
  return template.spec.metrics as Metric[];
};

describe('the canary analysis', () => {
  it('fails a step whose canary has had too few requests, and says that is why', () => {
    const [first] = metricsOf(TEMPLATES.step);
    expect(first?.name).toBe('enough-requests');
    expect(first?.successCondition).toBe(`result[0] >= ${release.minRequests}`);
    expect(first?.failureLimit).toBe(0);
    // No requests at all is a count of nought, not an empty answer that a condition cannot read.
    expect(first?.provider.prometheus?.query).toMatch(/or vector\(0\)$/);
  });

  it('counts only what the traffic split sent the canary through the ingress, not the journeys’ own requests', () => {
    const { requests } = queries(release);
    expect(requests).toBe(
      'sum(increase(traefik_service_requests_total{service="website-website-canary-80@kubernetescrd"}[3m])) or vector(0)',
    );
    // The app's own count of the canary's requests includes the journeys, which ask its Service directly.
    expect(requests).not.toContain('http_server_request_duration_seconds');
    expect(requests).not.toContain('canary-hash');
  });

  it('names a Service as Traefik’s metrics do when a weighted service sends to it', () => {
    expect(ingressServiceOf('http://website-canary.website')).toBe('website-website-canary-80@kubernetescrd');
    expect(ingressServiceOf('http://shop.web:8080')).toBe('web-shop-8080@kubernetescrd');
    expect(() => ingressServiceOf('http://website-canary')).toThrow(/<name>\.<namespace>/);
  });

  it('judges errors and latency against the baseline, and only once there is enough to judge', () => {
    const q = queries(release);
    for (const query of [q.errors, q.latency]) {
      expect(query).toContain('{{args.canary-hash}}');
      expect(query).toContain('{{args.stable-hash}}');
      // Judged only once the split has sent the canary enough, so too little traffic fails on that alone.
      expect(query).toMatch(
        new RegExp(`and on \\(\\) sum\\(increase\\(traefik_service_requests_total\\{.*\\) >= ${release.minRequests}$`),
      );
      // Every route at once: no query names one, or depends on how the app names them.
      expect(query).not.toMatch(/http_route="/);
      expect(query).not.toContain('by (http_route)');
    }
    // A baseline with no series fails the canary, rather than leaving nothing to compare.
    expect(q.errors).toContain('or on () vector(Inf)');
    expect(q.latency).toContain('or on () vector(Inf)');
    expect(q.errors).toContain('http_response_status_code=~"5.."');
    expect(q.latency).toContain(`histogram_quantile(${release.latency.percentile},`);
    expect(q.latency).toContain(`* ${release.latency.maxRatioAbove}, ${release.latency.minSecondsAbove})`);
    const [, errors, latency] = metricsOf(TEMPLATES.step);
    expect(errors?.successCondition).toBe(`len(result) == 0 || result[0] <= ${release.errors.maxAbove}`);
    expect(latency?.successCondition).toBe('len(result) == 0 || result[0] <= 0');
    // Each judges its figure with the switch.
    expect(errors?.provider.prometheus?.query).toBe(switched(q.errors));
    expect(latency?.provider.prometheus?.query).toBe(switched(q.latency));
  });

  it('runs the journeys gate with the stable Service as the base and the canary as the change', () => {
    const journeys = metricsOf(TEMPLATES.step).find((m) => m.name === 'journeys');
    const [container] = journeys?.provider.job?.spec.template.spec.containers ?? [];
    expect(container?.image).toBe('factory-browser');
    expect(container?.args).toEqual([
      'src/cli.ts',
      'gate',
      'journeys',
      '--base',
      release.app.stable,
      '--change',
      release.app.canary,
    ]);
    expect(journeys?.failureLimit).toBe(0);
  });

  it('looks at every measure throughout, failing on the policy’s count of failed looks', () => {
    const background = metricsOf(TEMPLATES.background);
    expect(background.map((m) => m.name)).toEqual(['errors', 'latency', 'journeys']);
    for (const metric of background) expect(metric.failureLimit).toBe(release.background.failures - 1);
    // With auto-rollback off, paused on the look that would have failed it, not the first bad one.
    for (const metric of background.slice(0, 2)) {
      expect(metric.inconclusiveLimit).toBe(release.background.failures - 1);
    }
    const [errors, latency, journeys] = background;
    expect(errors?.interval).toBe(`${release.background.intervalMinutes}m`);
    expect(latency?.interval).toBe(`${release.background.intervalMinutes}m`);
    // The same Job as at a step, every few minutes, starting half an interval in: between the steps' runs.
    expect(journeys?.provider.job).toEqual(metricsOf(TEMPLATES.step).find((m) => m.name === 'journeys')?.provider.job);
    expect(journeys?.interval).toBe(`${release.background.journeysIntervalMinutes}m`);
    expect(journeys?.initialDelay).toBe(`${release.background.journeysIntervalMinutes * 30}s`);
  });

  it('leave the journeys and too few requests to fail whatever auto-rollback says: neither can be inconclusive', () => {
    for (const metrics of [metricsOf(TEMPLATES.step), metricsOf(TEMPLATES.background)]) {
      for (const metric of metrics.filter((m) => m.name === 'journeys' || m.name === 'enough-requests')) {
        expect(metric.failureCondition, metric.name).toBeUndefined();
        expect(metric.provider.prometheus?.query ?? '', metric.name).not.toContain('auto_rollback');
      }
    }
  });

  it('pause at a step on the first bad figure with auto-rollback off, as they fail on it with it on', () => {
    for (const metric of metricsOf(TEMPLATES.step).filter((m) => m.name === 'errors' || m.name === 'latency')) {
      expect(metric.failureLimit).toBe(0);
      expect(metric.inconclusiveLimit).toBe(0);
    }
  });

  it('follow the policy', () => {
    const stricter = {
      ...release,
      windowMinutes: 5,
      minRequests: 300,
      errors: { maxAbove: 0.005 },
      latency: { percentile: 0.95, maxRatioAbove: 0.1, minSecondsAbove: 0.05 },
    };
    const text = render(stricter);
    expect(text).toContain('[5m]');
    expect(text).toContain('>= 300');
    expect(text).toContain('result[0] <= 0.005');
    expect(text).toContain('histogram_quantile(0.95,');
    expect(text).toContain('* 0.1, 0.05)');
    expect(text).not.toBe(render(release));
  });

  it('are what is committed, as two cluster-scoped templates: the check passes now, and fails when the policy moves on', () => {
    const committed = readFileSync(TEMPLATES_FILE, 'utf8');
    expect(committed).toBe(render(release));
    const documents = parseAllDocuments(committed).map((d) => d.toJS());
    expect(documents.map((d) => [d.kind, d.metadata.name, d.metadata.namespace])).toEqual([
      ['ClusterAnalysisTemplate', TEMPLATES.step, undefined],
      ['ClusterAnalysisTemplate', TEMPLATES.background, undefined],
    ]);
    expect(outOfDate(release)).toBe(false);
    expect(outOfDate({ ...release, minRequests: release.minRequests + 1 })).toBe(true);
  });

  it('fail the check when the file is missing or edited by hand', () => {
    const folder = mkdtempSync(join(tmpdir(), 'analysis-'));
    const file = join(folder, 'templates.yaml');
    expect(outOfDate(release, file)).toBe(true);
    writeFileSync(file, render(release));
    expect(outOfDate(release, file)).toBe(false);
    writeFileSync(file, render(release).replace(`>= ${release.minRequests}`, '>= 1'));
    expect(outOfDate(release, file)).toBe(true);
  });
});

/**
 * A condition as Argo Rollouts evaluates it (expr): `len`, `result`, `||`, `&&` and `!`, which mean in it what they
 * mean in JavaScript, over the answer's figures.
 */
function evaluate(condition: string, result: number[]): boolean {
  return new Function('result', 'len', `return ${condition};`)(result, (a: unknown[]) => a.length) as boolean;
}

/** A measurement's phase from its conditions, as Argo Rollouts decides it: failure first, then success. */
function phase(c: { successCondition: string; failureCondition: string }, result: number[]) {
  if (evaluate(c.failureCondition, result)) return 'Failed';
  return evaluate(c.successCondition, result) ? 'Successful' : 'Inconclusive';
}

describe('auto-rollback, as the analysis reads it', () => {
  const latency = conditions('result[0] <= 0');

  it('passes a good figure, and nothing to judge, whatever the switch', () => {
    expect(phase(latency, [])).toBe('Successful');
    expect(phase(latency, [-0.02])).toBe('Successful');
    expect(phase(latency, [-0.02, -0.02])).toBe('Successful');
  });

  it('fails a bad figure answered once, and calls one answered twice, with the switch off, inconclusive', () => {
    expect(phase(latency, [0.17])).toBe('Failed');
    expect(phase(latency, [0.17, 0.17])).toBe('Inconclusive');
    // A version with nothing to compare is infinitely worse, and NaN is no figure within a limit: both bad.
    expect(phase(latency, [Number.POSITIVE_INFINITY])).toBe('Failed');
    expect(phase(latency, [Number.NaN])).toBe('Failed');
    expect(phase(latency, [Number.NaN, Number.NaN])).toBe('Inconclusive');
    // Any other number of answers fails: only the switch's two are inconclusive.
    expect(phase(latency, [0.17, 0.17, 0.17])).toBe('Failed');
  });

  it('believes the series as the alerts believe a worker’s', () => {
    expect(SWITCH_FRESH).toBe(PUSHED_FRESH);
  });

  /** Whether the switch's query answers its figure twice at 5m, given these series of the switch over the 5 minutes. */
  function offAt5m(series: { series: string; values: string }[]): boolean {
    const folder = mkdtempSync(join(tmpdir(), 'auto-rollback-'));
    const test = (expected: number) => ({
      interval: '15s',
      input_series: [{ series: 'figure', values: '0.17x40' }, ...series],
      promql_expr_test: [
        {
          expr: `count(${switched('sum(figure)')})`,
          eval_time: '5m',
          exp_samples: [{ labels: '{}', value: expected }],
        },
      ],
    });
    writeFileSync(
      join(folder, 'tests.yml'),
      stringify({ rule_files: [], evaluation_interval: '15s', tests: [test(2)] }, { lineWidth: 0 }),
    );
    try {
      execFileSync('promtool', ['test', 'rules', join(folder, 'tests.yml')], { encoding: 'utf-8', stdio: 'pipe' });
      return true;
    } catch {
      // Not two: check it is one, so a query that answers nothing (or fails to parse) does not pass as "on".
      writeFileSync(
        join(folder, 'tests.yml'),
        stringify({ rule_files: [], evaluation_interval: '15s', tests: [test(1)] }, { lineWidth: 0 }),
      );
      const output = (() => {
        try {
          return execFileSync('promtool', ['test', 'rules', join(folder, 'tests.yml')], { encoding: 'utf-8' });
        } catch (error) {
          const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
          throw new Error(`neither one answer nor two:\n${stdout}${stderr}`);
        }
      })();
      expect(output).toContain('SUCCESS');
      return false;
    }
  }

  const admin = (value: string, extra = '') => ({
    series: `admin_auto_rollback{${METRICS_FROM_THE_ADMIN_SERVICE}${extra}}`,
    values: value,
  });
  const line = (value: string, extra = '') => ({
    series: `line_auto_rollback{${METRICS_FROM_THE_LINE}${extra}}`,
    values: value,
  });
  /** Fresh throughout the five minutes, every 15 seconds. */
  const steady = (v: number) => `${v}x20`;

  it('is off only with exactly one fresh series from each pod, both reading 0', () => {
    expect(offAt5m([admin(steady(0)), line(steady(0))])).toBe(true);
  });

  it('is on, and a bad canary rolls back, with anything else', () => {
    // Either on.
    expect(offAt5m([admin(steady(1)), line(steady(0))])).toBe(false);
    expect(offAt5m([admin(steady(0)), line(steady(1))])).toBe(false);
    // Either missing: the admin service down, the line not yet scraped.
    expect(offAt5m([line(steady(0))])).toBe(false);
    expect(offAt5m([admin(steady(0))])).toBe(false);
    expect(offAt5m([])).toBe(false);
    // Either stale: its last sample over a minute old, from a worker gone.
    expect(offAt5m([admin('0x10'), line(steady(0))])).toBe(false);
    // Two series from one pod: which to believe is not known.
    expect(offAt5m([admin(steady(0)), admin(steady(0), ', instance="b"'), line(steady(0))])).toBe(false);
    // Off from any other pod is no word of the admin service's or the line's.
    const triage = 'k8s_namespace_name="factory", k8s_pod_label_app_kubernetes_io_name="triage"';
    expect(
      offAt5m([
        { series: `admin_auto_rollback{${triage}}`, values: steady(0) },
        { series: `line_auto_rollback{${triage}}`, values: steady(0) },
      ]),
    ).toBe(false);
  });

  it('parses as Prometheus reads it, around the real measures', () => {
    const folder = mkdtempSync(join(tmpdir(), 'auto-rollback-'));
    const q = queries(release);
    const real = (query: string) =>
      switched(query).replaceAll('{{args.canary-hash}}', 'c4n4ry').replaceAll('{{args.stable-hash}}', 's74b1e');
    writeFileSync(
      join(folder, 'tests.yml'),
      stringify(
        {
          rule_files: [],
          tests: [
            {
              interval: '15s',
              input_series: [],
              promql_expr_test: [q.errors, q.latency].map((query) => ({
                expr: real(query),
                eval_time: '5m',
                exp_samples: [],
              })),
            },
          ],
        },
        { lineWidth: 0 },
      ),
    );
    expect(execFileSync('promtool', ['test', 'rules', join(folder, 'tests.yml')], { encoding: 'utf-8' })).toContain(
      'SUCCESS',
    );
  });
});
