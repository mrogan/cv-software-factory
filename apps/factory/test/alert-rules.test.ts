import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import { STUCK } from '../../../policy/stuck.ts';
import * as query from '../src/alerts/queries.ts';
import {
  BUDGET_WINDOWS,
  budgetRulesFor,
  OBJECTIVES,
  outOfDate,
  RULES_FILE,
  render,
  rulesFor,
  SLOW_INTERVAL,
  stuckRulesFor,
} from '../src/alerts/rules.ts';
import { coder } from '../src/line/agents/coder.ts';
import { describer } from '../src/line/agents/describer.ts';
import { planner } from '../src/line/agents/planner.ts';
import { reviewer } from '../src/line/agents/reviewer.ts';
import { OPEN_STAGES } from '../src/line/metrics.ts';
import { leaseFor } from '../src/line/worker.ts';

describe('alerting rules', () => {
  it('judge every route alike, and only one with enough requests', () => {
    const [errors, latency] = rulesFor(objectives);
    expect(errors?.expr).toContain('sum by (http_route)');
    expect(errors?.expr).toContain(`> ${objectives.errorRatio.max}`);
    expect(errors?.expr).toContain(`>= ${objectives.minRequests}`);
    expect(latency?.expr).toContain(`histogram_quantile(${objectives.latency.percentile}`);
    expect(latency?.expr).toContain(`> ${objectives.latency.maxSeconds}`);
    // No rule names a route: the route comes from the series.
    for (const rule of [errors, latency]) expect(rule?.expr).not.toMatch(/http_route="/);
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

  it('read hours or days only every few minutes, and the last hour every minute', () => {
    const slow = rules.filter((rule) => rule.slow).map((rule) => rule.record);
    expect(slow).toEqual([
      'website:requests_bad:ratio_rate6h',
      'website:error_budget_burn:rate6h',
      'website:requests_bad:ratio_rate7d',
      'website:error_budget_remaining:ratio7d',
    ]);
    expect(render(objectives)).toContain(`- name: error-budget-over-hours\n        interval: ${SLOW_INTERVAL}\n`);
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
    for (const rule of stuckRulesFor(STUCK).filter((r) => r.record !== 'line:stage_limit_seconds')) {
      expect(rule.expr).not.toMatch(/\bsum\b/);
    }
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
