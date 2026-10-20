/**
 * Prometheus's rules, generated from the policy: the alerting rules from the app's objectives
 * (policy/objectives.ts), and the recording rules the dashboards draw: each route against the objectives, the
 * objectives' error budget, and the line's stuck limits (policy/stuck.ts).
 *
 *     node apps/factory/src/alerts/rules.ts            # write the rules
 *     node apps/factory/src/alerts/rules.ts --check    # fail if they are out of date (make check, CI)
 *
 * The output is a values file for the Prometheus chart: `serverFiles` is where the chart keeps its rule files. A rule
 * judges each route that has had enough requests, by the same expression as the figure recorded for the dashboards, and
 * the alert carries the route and the symptom class as labels, which is all the intake needs to make a signal of it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Objectives, objectives } from '../../../../policy/objectives.ts';
import { STUCK, type StuckStage } from '../../../../policy/stuck.ts';
import * as query from './queries.ts';

export const RULES_FILE = join(import.meta.dirname, '../../../../deploy/base/telemetry/values/prometheus-rules.yaml');

/** The `objective` label of each rule: the intake reads it to know what to plot. */
export const OBJECTIVES = { errorRatio: 'error-ratio', latency: 'latency' } as const;

interface Rule {
  alert: string;
  expr: string;
  for: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** What `{{ $labels.http_route }}` makes of a route in an alert, once Prometheus has expanded it. */
const ROUTE = '{{ $labels.http_route }}';

/**
 * One rule per objective. Each judges every route alike, and only one that has had `minRequests` in the window, by the
 * very expression recorded for the dashboards (`routeRulesFor`). It does not read the recorded series: anything that
 * sends metrics over OTLP could send one by that name, and an alert judges only the app's own requests.
 */
export function rulesFor(o: Objectives): Rule[] {
  const route = routeFigures(o);
  const window = `${o.windowMinutes} minutes`;
  const hold = `${o.holdMinutes}m`;
  return [
    {
      alert: 'RouteErrorRatioAboveObjective',
      expr: `(${route.errorRatio}) > ${o.errorRatio.max}`,
      for: hold,
      labels: { route: ROUTE, symptom: 'server-error', objective: OBJECTIVES.errorRatio },
      annotations: {
        summary: `${ROUTE}: more than ${percent(o.errorRatio.max)} of requests answered with a 5xx status`,
        description: `Over ${window}, with at least ${o.minRequests} requests.`,
        threshold: String(o.errorRatio.max),
      },
    },
    {
      alert: 'RouteLatencyAboveObjective',
      expr: `(${route.latency}) > ${o.latency.maxSeconds}`,
      for: hold,
      labels: { route: ROUTE, symptom: 'slow-response', objective: OBJECTIVES.latency },
      annotations: {
        summary: `${ROUTE}: ${query.percentileName(o.latency.percentile)} latency above ${o.latency.maxSeconds} s`,
        description: `Over ${window}, with at least ${o.minRequests} requests.`,
        threshold: String(o.latency.maxSeconds),
      },
    },
  ];
}

const percent = (share: number) => `${Number((share * 100).toFixed(2))}%`;

interface Recording {
  record: string;
  expr: string;
  labels?: Record<string, string>;
}

/**
 * The names of the figures the objectives judge a route by, over their window (15 minutes): its requests, its share of
 * 5xx answers and its latency at the objective's percentile, as `website:route_errors:ratio_rate15m`.
 */
export function routeRecords(o: Objectives) {
  const w = `${o.windowMinutes}m`;
  const percentile = o.latency.percentile * 100;
  if (Math.abs(percentile - Math.round(percentile)) > 1e-9) {
    throw new Error(
      `The latency objective's percentile, ${o.latency.percentile}, is not a whole one to name a series by`,
    );
  }
  return {
    requests: `website:route_requests:increase${w}`,
    errorRatio: `website:route_errors:ratio_rate${w}`,
    latency: `website:route_latency_seconds:${query.percentileName(o.latency.percentile)}_rate${w}`,
  };
}

/**
 * Each route against the objectives, as the alerting rules judge it and the dashboards draw it: its requests in the
 * window, and its error ratio and latency only when it has had `minRequests`. A route that has answered no 5xx has an
 * error ratio of 0, not none. Each reads the app's own series alone, never a recorded one.
 */
export function routeFigures(o: Objectives): { requests: string; errorRatio: string; latency: string } {
  const enough = `on (http_route) (${query.requests(o)} >= ${o.minRequests})`;
  const all = query.requestRate(o);
  return {
    requests: query.requests(o),
    errorRatio: `((${query.errorRate(o)} or ${all} * 0) / ${all}) and ${enough}`,
    latency: `${query.latency(o)} and ${enough}`,
  };
}

/** The routes' figures, recorded for the dashboards under `routeRecords`' names. */
export function routeRulesFor(o: Objectives): Recording[] {
  const names = routeRecords(o);
  const figures = routeFigures(o);
  return (['requests', 'errorRatio', 'latency'] as const).map((figure) => ({
    record: names[figure],
    expr: figures[figure],
  }));
}

/**
 * How often the error budget's five-minute rates are recorded: each covers the five minutes before it, so a window of
 * hours or days is a sum of one sample every five minutes (2,016 over seven days). What is read from them is recorded
 * every minute, as Prometheus would find no sample of a series recorded only as often as it looks back for one (five
 * minutes) while its next is being written.
 */
export const BUDGET_INTERVAL = '5m';

/** Whether a rule of the budget is one of its five-minute rates, recorded every `BUDGET_INTERVAL`. */
export const isBudgetRate = (rule: Recording) => rule.record.endsWith(':rate5m');

/** The windows the share of bad requests is recorded over: two for how fast the budget burns, and the budget's own. */
export const BUDGET_WINDOWS = ['1h', '6h', '7d'] as const;

/**
 * The app's error budget, one for each objective, over every route together: the share of its requests each objective
 * allows to be bad, and how much of that the last seven days have left. A request is bad for the error ratio when it
 * answers with a 5xx status, and for latency when it is slower than the objective's bound, which the percentile allows
 * that share of. The requests are the alerting rules' (the app's own, to a route), recorded as a rate over each five
 * minutes, every five minutes (`BUDGET_INTERVAL`), so a longer window is a sum of those and costs one series to read.
 */
export function budgetRulesFor(o: Objectives): Recording[] {
  const { maxSeconds } = o.latency;
  if (!(query.LATENCY_BUCKETS as readonly number[]).includes(maxSeconds)) {
    throw new Error(`The latency objective, ${maxSeconds} s, is not a bound of the app's buckets`);
  }
  const rate = (extra: string[] = [], series = 'count') =>
    `sum(rate(${query.REQUESTS}_${series}${query.matchers(o, {}, extra)}[5m]))`;
  const allowed = (share: number) => `vector(${Number(share.toFixed(6))})`;
  return [
    { record: 'website:requests:rate5m', expr: rate() },
    {
      record: 'website:requests_bad:rate5m',
      // A version that has answered no 5xx has no such series: none is none bad, not no figure.
      expr: `${rate(['http_response_status_code=~"5.."'])} or vector(0)`,
      labels: { objective: OBJECTIVES.errorRatio },
    },
    {
      record: 'website:requests_bad:rate5m',
      expr: `${rate()} - ${rate([`le="${maxSeconds}"`], 'bucket')}`,
      labels: { objective: OBJECTIVES.latency },
    },
    {
      record: 'website:error_budget:ratio',
      expr: allowed(o.errorRatio.max),
      labels: { objective: OBJECTIVES.errorRatio },
    },
    {
      record: 'website:error_budget:ratio',
      expr: allowed(1 - o.latency.percentile),
      labels: { objective: OBJECTIVES.latency },
    },
    ...BUDGET_WINDOWS.flatMap((w) => {
      const ratio = {
        record: `website:requests_bad:ratio_rate${w}`,
        expr: `sum_over_time(website:requests_bad:rate5m[${w}]) / ignoring (objective) group_left () (sum_over_time(website:requests:rate5m[${w}]) > 0)`,
      };
      const burn = {
        record: `website:error_budget_burn:rate${w}`,
        expr: `website:requests_bad:ratio_rate${w} / on (objective) website:error_budget:ratio`,
      };
      return w === '7d' ? [ratio] : [ratio, burn];
    }),
    {
      record: 'website:error_budget_remaining:ratio7d',
      expr: '1 - website:requests_bad:ratio_rate7d / on (objective) website:error_budget:ratio',
    },
  ];
}

/**
 * The line's stuck limits, a series for each stage that has one, and what each stage's figures say against them.
 * Two replicas of the line would each report the whole store's figures, so a stage's are read with `max`, never `sum`.
 *
 * And when the line last finished a step (`LAST_STEP`): a sample, its value its own time, each minute a step was
 * counted in the five before it, and none otherwise, so the last in a week is one read of a few samples.
 */
export function stuckRulesFor(stuck: Record<StuckStage, { minutes: number | null }>): Recording[] {
  const limits = Object.entries(stuck).flatMap(([stage, { minutes }]) =>
    minutes === null
      ? []
      : [{ record: 'line:stage_limit_seconds', expr: `vector(${minutes * 60})`, labels: { stage } }],
  );
  return [
    ...limits,
    { record: 'line:work_items:max', expr: 'max by (stage) (line_work_items)' },
    { record: 'line:stage_oldest_seconds:max', expr: 'max by (stage) (line_stage_oldest_seconds)' },
    {
      record: 'line:stage_oldest:ratio_to_limit',
      expr: 'line:stage_oldest_seconds:max / on (stage) line:stage_limit_seconds',
    },
    { record: LAST_STEP, expr: 'timestamp(sum(increase(line_steps_total[5m])) > 0)' },
  ];
}

/** When the line last finished a step, as a Unix time, up to five minutes late: read it with `last_over_time`. */
export const LAST_STEP = 'line:steps:last_timestamp_seconds';

/** The values file's text. Strings are JSON strings, which YAML reads as written. */
export function render(o: Objectives, stuck = STUCK): string {
  const map = (values: Record<string, string>, indent: string) =>
    Object.entries(values)
      .map(([key, value]) => `${indent}${key}: ${JSON.stringify(value)}`)
      .join('\n');
  const rules = rulesFor(o)
    .map(
      (rule) => `          - alert: ${rule.alert}
            expr: ${JSON.stringify(rule.expr)}
            for: ${rule.for}
            labels:
${map(rule.labels, '              ')}
            annotations:
${map(rule.annotations, '              ')}`,
    )
    .join('\n');
  const recordings = (group: Recording[]) =>
    group
      .map(
        (rule) => `          - record: ${rule.record}
            expr: ${JSON.stringify(rule.expr)}${rule.labels ? `\n            labels:\n${map(rule.labels, '              ')}` : ''}`,
      )
      .join('\n');
  return `# Generated from policy/objectives.ts and policy/stuck.ts by apps/factory/src/alerts/rules.ts. Do not edit it: change
# the policy, then run \`node apps/factory/src/alerts/rules.ts\`. \`make check\` fails when this file is out of date.
serverFiles:
  alerting_rules.yml:
    groups:
      - name: objectives
        rules:
${rules}
  recording_rules.yml:
    groups:
      - name: routes
        rules:
${recordings(routeRulesFor(o))}
      - name: error-budget-rates
        interval: ${BUDGET_INTERVAL}
        rules:
${recordings(budgetRulesFor(o).filter(isBudgetRate))}
      - name: error-budget
        rules:
${recordings(budgetRulesFor(o).filter((rule) => !isBudgetRate(rule)))}
      - name: line
        rules:
${recordings(stuckRulesFor(stuck))}
`;
}

/** Whether the file holds something other than what the objectives call for. */
export function outOfDate(o: Objectives, file: string = RULES_FILE): boolean {
  try {
    return readFileSync(file, 'utf8') !== render(o);
  } catch {
    return true;
  }
}

if (import.meta.main) {
  const where = relative(process.cwd(), RULES_FILE);
  if (process.argv.includes('--check')) {
    if (outOfDate(objectives)) {
      console.error(`${where} is out of date with the policy. Run: node apps/factory/src/alerts/rules.ts`);
      process.exit(1);
    }
    console.log(`${where} is current.`);
  } else {
    writeFileSync(RULES_FILE, render(objectives));
    console.log(`Wrote ${where}.`);
  }
}
