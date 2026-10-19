/**
 * Grafana's dashboards, held to one bar (#394): each parses and is provisioned, every panel says what it answers and
 * what good looks like, has a unit and says why it is empty, every series a query names exists, every link reaches a
 * dashboard, and every colour is the palette's, with an outcome the same colour everywhere.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { objectives } from '../../../../policy/objectives.ts';
import { SPEND_METRIC } from '../../src/gateway/metrics.ts';
import { GRAFANA, OUTCOMES, SERIES, STATUS } from './palette.ts';
import { HISTOGRAM_SUFFIXES, INSTRUMENTS, RULES, THIRD_PARTY } from './series.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const TELEMETRY = join(ROOT, 'deploy/base/telemetry');
const DASHBOARDS = join(TELEMETRY, 'dashboards');

/** Dashboards not yet up to the bar, held only to their series being real: #394's last pull request empties this. */
const NOT_YET = ['website'];

/** Dashboards a link may name that the next pull request of #394 adds; it empties this. */
const FORTHCOMING = ['platform'];

interface Target {
  refId?: string;
  datasource?: { type?: string; uid?: string };
  expr?: string;
  query?: unknown;
}

interface Override {
  matcher: { id: string; options?: unknown };
  properties: { id: string; value?: unknown }[];
}

interface Panel {
  id?: number;
  type: string;
  title?: string;
  description?: string;
  datasource?: { type?: string; uid?: string };
  targets?: Target[];
  panels?: Panel[];
  fieldConfig?: { defaults?: Record<string, unknown> & { links?: { url: string }[] }; overrides?: Override[] };
  links?: { url: string }[];
}

interface Dashboard {
  uid: string;
  title: string;
  description?: string;
  tags?: string[];
  links?: { type: string; tags?: string[]; url?: string }[];
  annotations?: { list: (Target & { builtIn?: number })[] };
  panels: Panel[];
}

const files = readdirSync(DASHBOARDS).filter((f) => f.endsWith('.json'));
const dashboards = files.map((file) => ({
  file,
  dashboard: JSON.parse(readFileSync(join(DASHBOARDS, file), 'utf-8')) as Dashboard,
}));
const all = (panels: Panel[]): Panel[] => panels.flatMap((p) => [p, ...all(p.panels ?? [])]);
const drawn = (d: Dashboard) => all(d.panels).filter((p) => p.type !== 'row' && p.type !== 'text');
const source = (target: Target, panel?: Panel) => target.datasource?.uid ?? panel?.datasource?.uid ?? 'prometheus';

/** Each query with the data source it is sent to, annotations' included. */
function queries(d: Dashboard): { uid: string; expr: string; where: string }[] {
  const fromPanels = drawn(d).flatMap((panel) =>
    (panel.targets ?? []).flatMap((t) =>
      t.expr ? [{ uid: source(t, panel), expr: t.expr, where: `${d.uid}: ${panel.title}` }] : [],
    ),
  );
  const fromAnnotations = (d.annotations?.list ?? []).flatMap((a) =>
    a.expr ? [{ uid: source(a), expr: a.expr, where: `${d.uid}: annotation` }] : [],
  );
  return [...fromPanels, ...fromAnnotations];
}

/**
 * The series a PromQL expression names: what is left once strings, selectors, ranges, label lists and Grafana's
 * variables are taken out, and functions and keywords are set aside.
 */
function seriesIn(expr: string): string[] {
  const bare = expr
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/g, ' ')
    .replace(/\$\{?\w+(?::\w+)?\}?/g, ' ');
  const names = [...bare.matchAll(/(?<![\w.:])([a-zA-Z_:][\w:]*)(\s*\()?/g)]
    .filter(([, , call]) => !call)
    .map(([, name]) => name as string);
  const keywords = new Set(['and', 'or', 'unless', 'bool', 'offset', 'inf', 'nan', 'Inf', 'NaN']);
  return [...new Set(names.filter((n) => !keywords.has(n)))];
}

/** Every instrument the factory's and the console's code creates. */
function instruments(): Set<string> {
  const made = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'test') walk(path);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(path, 'utf-8');
        for (const [, name] of text.matchAll(/\.create\w+\(\s*'([^']+)'/g)) made.add(name as string);
        if (/\.create\w+\(\s*SPEND_METRIC\b/.test(text)) made.add(SPEND_METRIC);
      }
    }
  };
  for (const dir of ['apps/factory/src', 'apps/console/src', 'packages']) walk(join(ROOT, dir));
  return made;
}

/** The services whose logs Loki holds: each worker's OTEL_SERVICE_NAME, the pod log collector's, and the app's. */
function services(): Set<string> {
  const names = new Set<string>([objectives.app.logsService]);
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.yaml')) {
        const text = readFileSync(path, 'utf-8');
        for (const [, name] of text.matchAll(/name: OTEL_SERVICE_NAME\s+value: "?([\w-]+)"?/g))
          names.add(name as string);
        for (const [, name] of text.matchAll(/key: service\.name\s+value: "?([\w-]+)"?/g)) names.add(name as string);
      }
    }
  };
  walk(join(ROOT, 'deploy/base'));
  return names;
}

const PALETTE = new Set<string>([...Object.values(STATUS), ...SERIES, ...GRAFANA]);

/** Every colour a panel names, with where. */
function colours(panel: Panel): { colour: string; override?: Override | undefined }[] {
  const found: { colour: string; override?: Override | undefined }[] = [];
  const fromValue = (value: unknown, override?: Override) => {
    const v = value as { fixedColor?: string; steps?: { color: string }[] } | undefined;
    if (v?.fixedColor) found.push({ colour: v.fixedColor, override });
    for (const step of v?.steps ?? []) found.push({ colour: step.color, override });
  };
  const defaults = panel.fieldConfig?.defaults ?? {};
  fromValue(defaults.color);
  fromValue(defaults.thresholds);
  for (const override of panel.fieldConfig?.overrides ?? []) {
    for (const property of override.properties) {
      if (property.id === 'color' || property.id === 'thresholds') fromValue(property.value, override);
    }
  }
  return found;
}

describe('Grafana’s dashboards', () => {
  it('are each provisioned, with a uid and a title of their own and the shared tag', () => {
    const kustomization = parse(readFileSync(join(TELEMETRY, 'kustomization.yaml'), 'utf-8')) as {
      configMapGenerator: { name: string; files: string[]; options?: { labels?: Record<string, string> } }[];
    };
    // One ConfigMap a dashboard, labelled for the sidecar: a copy of each rides in an annotation of 256 KiB at most.
    const provisioned = kustomization.configMapGenerator.filter((c) => c.options?.labels?.grafana_dashboard === '1');
    for (const map of provisioned) expect(map.files, map.name).toHaveLength(1);
    expect(provisioned.map((c) => c.files[0]?.replace('dashboards/', '')).sort()).toEqual([...files].sort());
    const uids = dashboards.map(({ dashboard }) => dashboard.uid);
    expect(new Set(uids).size).toBe(uids.length);
    const titles = dashboards.map(({ dashboard }) => dashboard.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const { file, dashboard } of dashboards) {
      expect(`${dashboard.uid}.json`, file).toBe(file);
      expect(dashboard.tags, file).toContain('software-factory');
    }
  });

  it('name only series that exist: the factory’s instruments, the recording rules, and known exporters’', () => {
    const made = instruments();
    const rules = readFileSync(join(TELEMETRY, 'values/prometheus-rules.yaml'), 'utf-8');
    for (const [series, instrument] of Object.entries(INSTRUMENTS)) expect(made, series).toContain(instrument);
    for (const rule of RULES) expect(rules, rule).toContain(`record: ${rule}\n`);

    const known = (name: string) =>
      [name, ...HISTOGRAM_SUFFIXES.filter((s) => name.endsWith(s)).map((s) => name.slice(0, -s.length))].some(
        (n) => n in INSTRUMENTS || n in THIRD_PARTY || RULES.includes(n),
      );
    let seen = 0;
    for (const { dashboard } of dashboards) {
      for (const query of queries(dashboard).filter((q) => q.uid === 'prometheus')) {
        for (const series of seriesIn(query.expr)) {
          expect(known(series), `${query.where} names ${series}, which nothing produces`).toBe(true);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('read logs only from services that send them', () => {
    const sending = services();
    let seen = 0;
    for (const { dashboard } of dashboards) {
      for (const query of queries(dashboard).filter((q) => q.uid === 'loki')) {
        for (const [, name] of query.expr.matchAll(/service_name="([^"]+)"/g)) {
          expect(sending, `${query.where} reads service ${name}`).toContain(name);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('link only to dashboards there are, by tag or by uid', () => {
    const uids = new Set([...dashboards.map(({ dashboard }) => dashboard.uid), ...FORTHCOMING]);
    for (const { dashboard } of dashboards) {
      for (const link of dashboard.links ?? []) {
        expect(link.type, dashboard.uid).toBe('dashboards');
        expect(link.tags, dashboard.uid).toEqual(['software-factory']);
      }
      for (const panel of drawn(dashboard)) {
        for (const link of [...(panel.links ?? []), ...(panel.fieldConfig?.defaults?.links ?? [])]) {
          const uid = /^\/d\/([\w-]+)/.exec(link.url)?.[1];
          expect(uids, `${dashboard.uid}: ${panel.title} links to ${link.url}`).toContain(uid);
        }
      }
    }
  });

  const held = dashboards.filter(({ dashboard }) => !NOT_YET.includes(dashboard.uid));

  it.each(held.map(({ dashboard }) => [dashboard.uid, dashboard]))(
    '%s: every panel says what it answers, in a unit, and why it is empty',
    (_, dashboard) => {
      expect(dashboard.description, dashboard.uid).toBeTruthy();
      expect(
        (dashboard.annotations?.list ?? []).filter((a) => a.builtIn === 1 && (a as { enable?: boolean }).enable),
      ).toEqual([]);
      for (const panel of drawn(dashboard)) {
        const where = `${dashboard.uid}: ${panel.title}`;
        expect(panel.title, where).toBeTruthy();
        expect(panel.description?.length ?? 0, `${where} has no description`).toBeGreaterThan(20);
        expect(panel.targets?.length ?? 0, `${where} has no query`).toBeGreaterThan(0);
        // Grafana's logs panel draws neither a unit nor an empty state of its own.
        if (panel.type === 'logs') continue;
        expect(panel.fieldConfig?.defaults?.noValue, `${where} has no empty state`).toBeTruthy();
        // A table of spans takes its columns' units from Tempo.
        const spans = panel.type === 'table' && (panel.targets ?? []).every((t) => source(t, panel) === 'tempo');
        if (!spans) expect(panel.fieldConfig?.defaults?.unit, `${where} has no unit`).toBeTruthy();
      }
    },
  );

  it.each(held.map(({ dashboard }) => [dashboard.uid, dashboard]))(
    '%s: every colour is the palette’s, and each outcome its own everywhere',
    (_, dashboard) => {
      for (const panel of drawn(dashboard)) {
        for (const { colour, override } of colours(panel)) {
          const where = `${dashboard.uid}: ${panel.title}`;
          expect(PALETTE, `${where} uses ${colour}`).toContain(colour);
          const named = String(override?.matcher.options ?? '');
          const outcomes = Object.keys(OUTCOMES).filter((o) => new RegExp(`(^|[^\\w-])${o}($|[^\\w-])`).test(named));
          // A threshold's base, below its first step, is nothing yet: it may be Grafana's text, or none.
          if (outcomes.length === 1 && !(GRAFANA as readonly string[]).includes(colour)) {
            const outcome = outcomes[0] as string;
            expect(colour, `${where}: ${outcome}`).toBe(STATUS[OUTCOMES[outcome] as keyof typeof STATUS]);
          }
        }
      }
    },
  );
});

describe('reading the series a query names', () => {
  it('leaves out labels, functions, keywords, ranges and Grafana’s variables', () => {
    expect(
      seriesIn(
        'histogram_quantile(0.95, sum by (le, stage) (increase(line_stage_duration_seconds_bucket{stage=~"$s"}[$__range]))) and on (stage) line:stage_limit_seconds > 0 or vector(1e6)',
      ),
    ).toEqual(['line_stage_duration_seconds_bucket', 'line:stage_limit_seconds']);
    expect(seriesIn('time() - max(max_over_time((timestamp(increase(line_steps_total[2m]) > 0))[7d:1m]))')).toEqual([
      'line_steps_total',
    ]);
    expect(seriesIn('{service_name="factory"}')).toEqual([]);
  });
});
