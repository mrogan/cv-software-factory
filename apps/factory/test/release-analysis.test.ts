import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';
import { release } from '../../../policy/release.ts';
import { outOfDate, queries, render, TEMPLATES, TEMPLATES_FILE, templatesFor } from '../src/release/analysis.ts';

interface Metric {
  name: string;
  interval?: string;
  initialDelay?: string;
  successCondition?: string;
  failureLimit?: number;
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

  it('judges errors and latency against the baseline, and only once there is enough to judge', () => {
    const q = queries(release);
    for (const query of [q.errors, q.latency]) {
      expect(query).toContain('{{args.canary-hash}}');
      expect(query).toContain('{{args.stable-hash}}');
      expect(query).toMatch(new RegExp(`and on \\(\\) sum\\(increase\\(.*canary-hash.*\\) >= ${release.minRequests}$`));
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
    const [errors, latency, journeys] = background;
    expect(errors?.interval).toBe(`${release.background.intervalMinutes}m`);
    expect(latency?.interval).toBe(`${release.background.intervalMinutes}m`);
    // The same Job as at a step, every few minutes, starting half an interval in: between the steps' runs.
    expect(journeys?.provider.job).toEqual(metricsOf(TEMPLATES.step).find((m) => m.name === 'journeys')?.provider.job);
    expect(journeys?.interval).toBe(`${release.background.journeysIntervalMinutes}m`);
    expect(journeys?.initialDelay).toBe(`${release.background.journeysIntervalMinutes * 30}s`);
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
