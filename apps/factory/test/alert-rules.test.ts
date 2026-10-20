import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import { STUCK } from '../../../policy/stuck.ts';
import * as query from '../src/alerts/queries.ts';
import {
  BUDGET_INTERVAL,
  BUDGET_WINDOWS,
  budgetRulesFor,
  LAST_STEP,
  OBJECTIVES,
  outOfDate,
  RULES_FILE,
  render,
  routeRecords,
  routeRulesFor,
  rulesFor,
  stuckRulesFor,
} from '../src/alerts/rules.ts';
import { coder } from '../src/line/agents/coder.ts';
import { describer } from '../src/line/agents/describer.ts';
import { planner } from '../src/line/agents/planner.ts';
import { reviewer } from '../src/line/agents/reviewer.ts';
import { OPEN_STAGES } from '../src/line/metrics.ts';
import { leaseFor } from '../src/line/worker.ts';

describe('alerting rules', () => {
  it('judge every route alike, by the figures recorded for each, which the dashboards draw', () => {
    const [errors, latency] = rulesFor(objectives);
    const route = routeRecords(objectives);
    expect(errors?.expr).toBe(`${route.errorRatio} > ${objectives.errorRatio.max}`);
    expect(latency?.expr).toBe(`${route.latency} > ${objectives.latency.maxSeconds}`);
  });

  it('label each alert with its route and symptom class', () => {
    const [errors, latency] = rulesFor(objectives);
    expect(errors?.labels).toMatchObject({ route: '{{ $labels.http_route }}', symptom: 'server-error' });
    expect(latency?.labels).toMatchObject({ route: '{{ $labels.http_route }}', symptom: 'slow-response' });
  });

  it('follow the policy', () => {
    const stricter = { ...objectives, errorRatio: { max: 0.01 }, windowMinutes: 5, minRequests: 50 };
    const text = render(stricter);
    expect(text).toContain('> 0.01');
    expect(text).toContain('[5m]');
    expect(text).toContain('>= 50');
    expect(text).not.toBe(render(objectives));
  });

  it('are what is committed: the check passes now, and fails when the policy moves on', () => {
    expect(readFileSync(RULES_FILE, 'utf8')).toBe(render(objectives));
    expect(outOfDate(objectives)).toBe(false);
    expect(outOfDate({ ...objectives, minRequests: objectives.minRequests + 1 })).toBe(true);
  });

  it('fail the check when the file is missing or edited by hand', () => {
    const folder = mkdtempSync(join(tmpdir(), 'rules-'));
    const file = join(folder, 'rules.yaml');
    expect(outOfDate(objectives, file)).toBe(true);
    writeFileSync(file, render(objectives));
    expect(outOfDate(objectives, file)).toBe(false);
    writeFileSync(file, `${render(objectives)}# edited\n`);
    expect(outOfDate(objectives, file)).toBe(true);
  });
});

describe('each route’s recording rules', () => {
  const route = routeRecords(objectives);
  const [requests, errors, latency] = routeRulesFor(objectives);

  it('are named for the objectives’ window and percentile', () => {
    expect(route).toEqual({
      requests: 'website:route_requests:increase15m',
      errorRatio: 'website:route_errors:ratio_rate15m',
      latency: 'website:route_latency_seconds:p95_rate15m',
    });
    expect(routeRecords({ ...objectives, windowMinutes: 30 }).errorRatio).toBe('website:route_errors:ratio_rate30m');
  });

  it('judge every route alike, and only one with enough requests', () => {
    expect(requests).toEqual({ record: route.requests, expr: query.requests(objectives) });
    expect(errors?.expr).toContain('sum by (http_route)');
    expect(errors?.expr).toContain('http_response_status_code=~"5.."');
    expect(latency?.expr).toContain(`histogram_quantile(${objectives.latency.percentile}`);
    for (const rule of [errors, latency]) {
      expect(rule?.expr).toContain(`[${objectives.windowMinutes}m]`);
      expect(rule?.expr).toMatch(
        new RegExp(`and on \\(http_route\\) \\(${route.requests} >= ${objectives.minRequests}\\)$`),
      );
      // No rule names a route: the route comes from the series.
      expect(rule?.expr).not.toMatch(/http_route="/);
    }
  });

  it('give a route with no 5xx an error ratio of 0, not none', () => {
    expect(errors?.expr).toContain(` or ${query.requestRate(objectives)} * 0) / `);
  });

  it('come before the alerting rules that read them, in a group of their own evaluated every minute', () => {
    expect(render(objectives)).toMatch(/- name: routes\n {8}rules:\n {10}- record: website:route_requests:/);
  });
});

describe('the error budget’s recording rules', () => {
  const rules = budgetRulesFor(objectives);
  const named = (record: string) => rules.filter((rule) => rule.record === record);

  it('count a request as bad by each objective’s own measure', () => {
    const [errors, latency] = named('website:requests_bad:rate5m');
    expect(errors?.labels).toEqual({ objective: OBJECTIVES.errorRatio });
    expect(errors?.expr).toContain('http_response_status_code=~"5.."');
    expect(latency?.labels).toEqual({ objective: OBJECTIVES.latency });
    expect(latency?.expr).toContain(`le="${objectives.latency.maxSeconds}"`);
  });

  it('allow each objective the share of requests it lets be bad', () => {
    const budgets = named('website:error_budget:ratio').map((rule) => [rule.labels?.objective, rule.expr]);
    expect(budgets).toEqual([
      [OBJECTIVES.errorRatio, `vector(${objectives.errorRatio.max})`],
      [OBJECTIVES.latency, `vector(${Number((1 - objectives.latency.percentile).toFixed(6))})`],
    ]);
  });

  it('record the share bad over an hour, six and the budget’s seven days, and the burn over the first two', () => {
    expect(BUDGET_WINDOWS).toEqual(['1h', '6h', '7d']);
    for (const w of BUDGET_WINDOWS) expect(named(`website:requests_bad:ratio_rate${w}`)).toHaveLength(1);
    expect(rules.filter((rule) => rule.record.startsWith('website:error_budget_burn:')).map((r) => r.record)).toEqual([
      'website:error_budget_burn:rate1h',
      'website:error_budget_burn:rate6h',
    ]);
    expect(named('website:error_budget_remaining:ratio7d')[0]?.expr).toContain('website:requests_bad:ratio_rate7d');
  });

  it('record the five-minute rates every five minutes, so seven days are a sum of 2,016 samples, not 10,080', () => {
    expect(BUDGET_INTERVAL).toBe('5m');
    expect(named('website:requests:rate5m')[0]?.expr).toContain('[5m]');
    expect(render(objectives)).toContain(
      `- name: error-budget\n        interval: ${BUDGET_INTERVAL}\n        rules:\n`,
    );
    // Every rule of the budget is in that group, the rates first, so each window reads the rates just recorded.
    const group = render(objectives).split('- name: error-budget\n')[1]?.split('- name: ')[0] ?? '';
    expect([...group.matchAll(/record: (\S+)/g)].map((m) => m[1])).toEqual(rules.map((rule) => rule.record));
    expect(rules[0]?.record).toBe('website:requests:rate5m');
  });

  it('refuse a latency objective that is not a bound of the app’s buckets, which no series could count', () => {
    expect(() => budgetRulesFor({ ...objectives, latency: { percentile: 0.95, maxSeconds: 0.8 } })).toThrow(
      /not a bound/,
    );
  });
});

describe('the line’s recording rules', () => {
  it('give every stage the line reports a limit or none, and no other', () => {
    expect(Object.keys(STUCK).sort()).toEqual([...OPEN_STAGES].sort());
  });

  it('leave a step and its one retry, to the end of their leases, half an hour to spare', () => {
    // A runner that dies is noticed only when its lease runs out; a step that fails runs once more.
    const lease = (agent: { deadlineSeconds: number }) => leaseFor(agent.deadlineSeconds) / 60;
    const spare = 30;
    expect(STUCK.plan.minutes).toBeGreaterThanOrEqual(2 * lease(planner) + spare);
    expect(STUCK.build.minutes).toBeGreaterThanOrEqual(2 * lease(coder) + spare);
    expect(STUCK.review.minutes).toBeGreaterThanOrEqual(
      lease(reviewer) + lease(describer) + Math.max(lease(reviewer), lease(describer)) + spare,
    );
  });

  it('record a limit for each stage that has one, in seconds', () => {
    const limits = stuckRulesFor(STUCK).filter((rule) => rule.record === 'line:stage_limit_seconds');
    const expected = Object.entries(STUCK).flatMap(([stage, { minutes }]) =>
      minutes === null ? [] : [[stage, `vector(${minutes * 60})`]],
    );
    expect(limits.map((rule) => [rule.labels?.stage, rule.expr])).toEqual(expected);
    expect(limits.map((rule) => rule.labels?.stage)).not.toContain('held');
  });

  it('read the line’s gauges with max, which two replicas would otherwise count twice', () => {
    // The steps are a counter, which each replica keeps of its own: they add up.
    const gauges = stuckRulesFor(STUCK).filter(
      (r) => r.record !== 'line:stage_limit_seconds' && r.record !== LAST_STEP,
    );
    for (const rule of gauges) {
      expect(rule.expr).not.toMatch(/\bsum\b/);
    }
  });

  it('record when a step was last counted, for a week’s last to be read cheaply', () => {
    const last = stuckRulesFor(STUCK).find((rule) => rule.record === LAST_STEP);
    expect(last?.expr).toBe('timestamp(sum(increase(line_steps_total[5m])) > 0)');
  });

  it('follow the policy', () => {
    const stricter = { ...STUCK, build: { minutes: 30 } };
    expect(render(objectives, stricter)).toContain('vector(1800)');
    expect(render(objectives, stricter)).not.toBe(render(objectives));
  });
});

describe('queries', () => {
  it('quote a route so that a path cannot change the query', () => {
    expect(query.errorRatio(objectives, { route: '/a"}) or vector(1) #' })).toContain(
      'http_route="/a\\"}) or vector(1) #"',
    );
  });

  it('plot one route with a plain sum, and judge all of them by route', () => {
    expect(query.errorRatio(objectives, { route: '/search' })).not.toContain('by (http_route)');
    expect(query.errorRatio(objectives)).toContain('by (http_route)');
  });
});
