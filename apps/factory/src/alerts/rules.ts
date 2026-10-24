/**
 * Prometheus's rules, generated from the policy: the alerting rules from the app's objectives
 * (policy/objectives.ts), the alerts to Martin (`martinRules`), and the recording rules the dashboards draw: each route
 * against the objectives, the objectives' error budget, and the line's stuck limits (policy/stuck.ts).
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
import { SECURITY_KINDS, type SecurityKind } from '../line/security.ts';
import { METRICS_FROM_THE_LINE } from '../provenance.ts';
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

/**
 * How loudly an alert reaches Martin, as its `level` label, through Pushover: Alertmanager pages him for `page` (high
 * priority, sounding through his quiet hours), notifies him for `notify` (normal priority) and informs him for `inform`
 * (low priority, with no sound or vibration), and sends an alert with none of them to no one
 * (deploy/base/telemetry/values/prometheus.yaml).
 */
export const LEVELS = { page: 'page', notify: 'notify', inform: 'inform' } as const;
export type Level = (typeof LEVELS)[keyof typeof LEVELS];

/**
 * How loudly each kind of security event reaches Martin. What loosens a guardrail, or changes who can sign in, pages
 * him; what widens what the line does, or acts on a release, notifies him; what tightens, or only records his own use,
 * informs him, but for tightening autonomy, which notifies him. Every kind still reaches his phone: only how loudly
 * changes.
 */
export const SECURITY_LEVELS: Record<SecurityKind, Level> = {
  'autonomy-loosened': LEVELS.page,
  'passkey-enrolled': LEVELS.page,
  'passkey-revoked': LEVELS.page,
  'guardrail-approved': LEVELS.page,
  'autonomy-tightened': LEVELS.notify,
  'auto-merge-on': LEVELS.notify,
  'take-widened': LEVELS.notify,
  'release-control': LEVELS.notify,
  'setting-changed': LEVELS.notify,
  'line-started': LEVELS.notify,
  'sign-in': LEVELS.inform,
  'stepped-up': LEVELS.inform,
  'new-work-on': LEVELS.inform,
  'new-work-off': LEVELS.inform,
  'auto-merge-off': LEVELS.inform,
  'take-narrowed': LEVELS.inform,
};

/** What an alert says of each kind of security event: its title, and a line more. Never anything of the session. */
const SECURITY_WORDS: Record<SecurityKind, { summary: string; description: string }> = {
  'sign-in': { summary: 'Signed in as Martin', description: 'A passkey signed in to the console.' },
  'passkey-enrolled': { summary: 'A passkey was enrolled', description: 'A new passkey can sign in as Martin.' },
  'passkey-revoked': { summary: 'A passkey was revoked', description: 'A passkey can no longer sign in as Martin.' },
  'setting-changed': {
    summary: 'A setting was changed',
    description: "An agent's model or effort, or a spend cap, was changed in the console.",
  },
  'stepped-up': {
    summary: 'The passkey was given again',
    description: 'For five minutes, the session may do what needs the passkey again.',
  },
  'release-control': {
    summary: 'A release was promoted or retried',
    description: "The app's canary was promoted, or a stopped release retried, from the console.",
  },
  'guardrail-approved': {
    summary: 'A guardrail was overridden',
    description: 'A hold whose cause is a guardrail was approved.',
  },
  'line-started': { summary: 'The line was started', description: 'The line takes work again.' },
  'autonomy-loosened': {
    summary: 'Autonomy was loosened',
    description: "The line's autonomy level was made looser in the console.",
  },
  'autonomy-tightened': {
    summary: 'Autonomy was tightened',
    description: "The line's autonomy level was made stricter in the console.",
  },
  'new-work-on': {
    summary: 'Agents take new work again',
    description: 'Agents were let take new work in the console.',
  },
  'new-work-off': {
    summary: 'Agents take no new work',
    description: 'Agents were stopped taking new work in the console.',
  },
  'auto-merge-on': {
    summary: 'Auto-merge was turned on',
    description: 'Auto-merge of low-risk changes was turned on in the console.',
  },
  'auto-merge-off': {
    summary: 'Auto-merge was turned off',
    description: 'Auto-merge of low-risk changes was turned off in the console.',
  },
  'take-widened': {
    summary: 'The line takes more',
    description: 'What the line takes was widened in the console.',
  },
  'take-narrowed': {
    summary: 'The line takes less',
    description: 'What the line takes was narrowed in the console.',
  },
};

/** One of the line's series, with any matcher given first, as only the line's pods send it. */
const fromTheLine = (name: string, matcher?: string) =>
  `${name}{${matcher ? `${matcher}, ` : ''}${METRICS_FROM_THE_LINE}}`;
export const SECURITY_EVENTS = fromTheLine('line_security_events_total');
export const HOLDS_STORED = fromTheLine('line_holds_stored_total');
/** Whether the line's last read of them from the store succeeded. */
const COUNTING = fromTheLine('line_security_events_counting');

/** How far back an alert to Martin looks for a new event: one or several in it are one message. */
const RECENT = '5m';

/**
 * The alerts to Martin (docs/COMPONENTS/ALERTING.md):
 * - an alert for each kind of security event, at its kind's level (`SECURITY_LEVELS`), the first of a kind included,
 *   from the line's count of them in the store, which starts at 0; several of a kind within five minutes are one alert;
 * - a page when that count has gone missing for ten minutes, having been there in the six hours before, or the line
 *   has not been able to read the store for five: no security event would reach him meanwhile;
 * - a page while Alertmanager has a silence in place, active or pending, from its own figures: a silence keeps pages
 *   from Martin, and nothing here makes one. A silence that matches this alert keeps it quiet too: the limit the dead
 *   man's switch covers (milestone 10). The rule takes the highest of any series by that name, so another can only page
 *   him more, never less;
 * - a notification for each hold started, by its cause, whoever started it.
 *
 * Each reads the line's series alone (`METRICS_FROM_THE_LINE`), and takes the highest of its replicas', which report the
 * same figure.
 */
export function martinRules(): Rule[] {
  const security = SECURITY_KINDS.map((kind) => ({
    alert: 'SecurityEvent',
    expr: `max(increase(${fromTheLine('line_security_events_total', `kind="${kind}"`)}[${RECENT}])) > 0`,
    for: '0s',
    labels: { level: SECURITY_LEVELS[kind], kind },
    annotations: SECURITY_WORDS[kind],
  }));
  return [
    ...security,
    {
      alert: 'SecurityEventsUncounted',
      expr: `(count(last_over_time(${SECURITY_EVENTS}[6h])) unless count(${SECURITY_EVENTS})) or max(${COUNTING}) == 0`,
      for: '5m',
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'Security events are not being counted',
        description:
          'The line has not counted sign-ins and the rest for some minutes, so none of them would reach you.',
      },
    },
    {
      alert: 'AlertmanagerSilenced',
      expr: 'max(alertmanager_silences{state=~"active|pending"}) > 0',
      for: '0s',
      labels: { level: LEVELS.page },
      annotations: {
        summary: 'Alerts are silenced',
        description: 'Alertmanager has a silence in place, which keeps the alerts it matches from your phone.',
      },
    },
    {
      alert: 'HoldStarted',
      expr: `max by (cause) (increase(${HOLDS_STORED}[${RECENT}])) > 0`,
      for: '0s',
      labels: { level: LEVELS.notify },
      annotations: {
        summary: 'A hold waits for you',
        description: 'A work item is held for your answer: {{ $labels.cause }}.',
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
  const alerts = (group: Rule[]) =>
    group
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
${alerts(rulesFor(o))}
      - name: martin
        rules:
${alerts(martinRules())}
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
