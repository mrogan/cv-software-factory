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
  isBudgetRate,
  LAST_STEP,
  LEVELS,
  martinRules,
  OBJECTIVES,
  outOfDate,
  RULES_FILE,
  render,
  routeRecords,
  routeRulesFor,
  rulesFor,
  SECURITY_LEVELS,
  stuckRulesFor,
} from '../src/alerts/rules.ts';
import { coder } from '../src/line/agents/coder.ts';
import { describer } from '../src/line/agents/describer.ts';
import { planner } from '../src/line/agents/planner.ts';
import { reviewer } from '../src/line/agents/reviewer.ts';
import { OPEN_STAGES } from '../src/line/metrics.ts';
import { SECURITY_KINDS } from '../src/line/security.ts';
import { leaseFor } from '../src/line/worker.ts';
import { METRICS_FROM_THE_LINE } from '../src/provenance.ts';

describe('alerting rules', () => {
  it('judge every route by the very expressions recorded for the dashboards, not the recorded series', () => {
    const [errors, latency] = rulesFor(objectives);
    const [, errorRatio, p95] = routeRulesFor(objectives);
    expect(errors?.expr).toBe(`(${errorRatio?.expr}) > ${objectives.errorRatio.max}`);
    expect(latency?.expr).toBe(`(${p95?.expr}) > ${objectives.latency.maxSeconds}`);
    // A recorded series is anyone's to send over OTLP by its name; the alerts read only the app's own.
    for (const rule of [errors, latency]) expect(rule?.expr).not.toContain('website:route_');
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
      expect(
        rule?.expr.endsWith(`and on (http_route) (${query.requests(objectives)} >= ${objectives.minRequests})`),
      ).toBe(true);
      // No rule names a route: the route comes from the series.
      expect(rule?.expr).not.toMatch(/http_route="/);
    }
  });

  it('give a route with no 5xx an error ratio of 0, not none', () => {
    expect(errors?.expr).toContain(` or ${query.requestRate(objectives)} * 0) / `);
  });

  it('are recorded every minute, in a group of their own', () => {
    expect(render(objectives)).toMatch(/- name: routes\n {8}rules:\n {10}- record: website:route_requests:/);
  });

  it('refuse a percentile that is not a whole one, which a series could not be named by', () => {
    expect(() => routeRecords({ ...objectives, latency: { percentile: 0.995, maxSeconds: 1 } })).toThrow(/whole/);
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
    const text = render(objectives);
    const group = (name: string) =>
      [...(text.split(`- name: ${name}\n`)[1]?.split('- name: ')[0] ?? '').matchAll(/record: (\S+)/g)].map((m) => m[1]);
    expect(text).toContain(`- name: error-budget-rates\n        interval: ${BUDGET_INTERVAL}\n        rules:\n`);
    expect(group('error-budget-rates')).toEqual([
      'website:requests:rate5m',
      'website:requests_bad:rate5m',
      'website:requests_bad:rate5m',
    ]);
    for (const rule of rules.filter(isBudgetRate)) expect(rule.expr).toContain('[5m]');
  });

  it('record what is read from them every minute, which Prometheus would not find while a five-minute one is written', () => {
    const text = render(objectives);
    expect(text).toMatch(/- name: error-budget\n {8}rules:\n/);
    const derived = rules.filter((rule) => !isBudgetRate(rule)).map((rule) => rule.record);
    expect(derived).toContain('website:error_budget_burn:rate1h');
    expect(derived).toContain('website:error_budget_remaining:ratio7d');
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

describe('the alerts to Martin', () => {
  const rules = martinRules();

  it('alert for each kind of security event, at its kind’s level, on the first of a kind too', () => {
    const security = rules.filter((rule) => rule.alert === 'SecurityEvent');
    expect(security.map((rule) => rule.labels.kind)).toEqual([...SECURITY_KINDS]);
    for (const rule of security) {
      expect(rule.labels.level).toBe(SECURITY_LEVELS[rule.labels.kind as keyof typeof SECURITY_LEVELS]);
      // A count that starts at 0, so the first is an increase; the highest of the replicas', which agree.
      expect(rule.expr).toBe(
        `max(increase(line_security_events_total{kind="${rule.labels.kind}", ${METRICS_FROM_THE_LINE}}[5m])) > 0`,
      );
      expect(rule.annotations.summary).toBeTruthy();
    }
  });

  it('page for what loosens a guardrail or changes who can sign in, notify of what widens the line’s work or acts on a release, and inform of the rest', () => {
    const at = (level: string) => SECURITY_KINDS.filter((kind) => SECURITY_LEVELS[kind] === level).sort();
    expect(at(LEVELS.page)).toEqual(['autonomy-loosened', 'guardrail-approved', 'passkey-enrolled', 'passkey-revoked']);
    expect(at(LEVELS.notify)).toEqual([
      'auto-merge-on',
      'autonomy-tightened',
      'line-started',
      'new-work-on',
      'release-control',
      'setting-changed',
      'take-widened',
    ]);
    expect(at(LEVELS.inform)).toEqual(['auto-merge-off', 'new-work-off', 'sign-in', 'stepped-up', 'take-narrowed']);
  });

  it('say only what happened: no label’s value but a cause from a closed list', () => {
    for (const rule of rules) {
      const words = `${rule.annotations.summary} ${rule.annotations.description}`;
      expect(words.replaceAll('{{ $labels.cause }}', ''), rule.alert).not.toContain('{{');
    }
  });

  it('read only the line’s own series, by what the collector stamps on them', () => {
    let read = 0;
    for (const rule of rules) {
      for (const [selector] of rule.expr.matchAll(/\bline_\w+(\{[^}]*\})?/g)) {
        expect(selector, rule.alert).toContain(METRICS_FROM_THE_LINE);
        // Never what a sender says of itself.
        expect(selector, rule.alert).not.toMatch(/\b(job|service_name|instance)=/);
        read++;
      }
    }
    expect(read).toBeGreaterThan(SECURITY_KINDS.length);
  });

  it('page when the count goes missing or stale, a silence is in place, and notify of each new hold', () => {
    const by = (name: string) => rules.filter((rule) => rule.alert === name);
    expect(by('SecurityEventsUncounted').map((rule) => rule.labels.level)).toEqual([LEVELS.page]);
    expect(by('SecurityEventsUncounted')[0]?.expr).toContain('line_security_events_counting');
    // The highest of every series by that name: another can page Martin more, never less.
    expect(by('AlertmanagerSilenced').map((rule) => [rule.labels.level, rule.expr])).toEqual([
      [LEVELS.page, 'max(alertmanager_silences{state=~"active|pending"}) > 0'],
    ]);
    expect(by('HoldStarted').map((rule) => rule.labels.level)).toEqual([LEVELS.notify]);
    expect(by('HoldStarted')[0]?.expr).toMatch(/^max by \(cause\) \(increase\(line_holds_stored_total\{/);
  });

  it('set a level Alertmanager routes, or none: a mistyped one would reach no one', () => {
    const generated = [...rulesFor(objectives), ...rules];
    for (const rule of generated) {
      expect([undefined, ...Object.values(LEVELS)], rule.alert).toContain(rule.labels.level);
    }
  });

  it('never carry an objective, so none reaches the intake', () => {
    for (const rule of rules) expect(Object.keys(rule.labels), rule.alert).not.toContain('objective');
    for (const rule of rulesFor(objectives)) expect(Object.keys(rule.labels)).not.toContain('level');
  });

  it('are in the rules file, in a group of their own', () => {
    const text = readFileSync(RULES_FILE, 'utf8');
    expect(text).toContain('      - name: martin\n        rules:\n          - alert: SecurityEvent\n');
  });
});
