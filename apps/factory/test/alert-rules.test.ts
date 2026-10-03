import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { objectives } from '../../../policy/objectives.ts';
import * as query from '../src/alerts/queries.ts';
import { outOfDate, RULES_FILE, render, rulesFor } from '../src/alerts/rules.ts';

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
