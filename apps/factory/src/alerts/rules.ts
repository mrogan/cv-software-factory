/**
 * Prometheus's alerting rules, generated from the app's objectives (policy/objectives.ts).
 *
 *     node apps/factory/src/alerts/rules.ts            # write the rules
 *     node apps/factory/src/alerts/rules.ts --check    # fail if they are out of date (make check, CI)
 *
 * The output is a values file for the Prometheus chart: `serverFiles` is where the chart keeps its rule files. A rule
 * judges each route that has had enough requests, and the alert carries the route and the symptom class as labels,
 * which is all the intake needs to make a signal of it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { type Objectives, objectives } from '../../../../policy/objectives.ts';
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

/** One rule per objective. Each judges every route alike, and only one that has had `minRequests` in the window. */
export function rulesFor(o: Objectives): Rule[] {
  const enough = `(${query.requests(o)} >= ${o.minRequests})`;
  const window = `${o.windowMinutes} minutes`;
  const hold = `${o.holdMinutes}m`;
  return [
    {
      alert: 'RouteErrorRatioAboveObjective',
      expr: `((${query.errorRatio(o)}) > ${o.errorRatio.max}) and on (http_route) ${enough}`,
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
      expr: `((${query.latency(o)}) > ${o.latency.maxSeconds}) and on (http_route) ${enough}`,
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

/** The values file's text. Strings are JSON strings, which YAML reads as written. */
export function render(o: Objectives): string {
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
  return `# Generated from policy/objectives.ts by apps/factory/src/alerts/rules.ts. Do not edit it: change the policy, then
# run \`node apps/factory/src/alerts/rules.ts\`. \`make check\` fails when this file is out of date.
serverFiles:
  alerting_rules.yml:
    groups:
      - name: objectives
        rules:
${rules}
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
      console.error(`${where} is out of date with policy/objectives.ts. Run: node apps/factory/src/alerts/rules.ts`);
      process.exit(1);
    }
    console.log(`${where} is current.`);
  } else {
    writeFileSync(RULES_FILE, render(objectives));
    console.log(`Wrote ${where}.`);
  }
}
