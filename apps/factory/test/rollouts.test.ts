import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse, parseAllDocuments } from 'yaml';

/** How deploy/ fits the app's canary in: when root syncs the website, and who says which version a record is from. */
const DEPLOY = fileURLToPath(new URL('../../../deploy/', import.meta.url));
const WAVE = 'argocd.argoproj.io/sync-wave';

interface Manifest {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
}

describe('the website syncs last', () => {
  it('in a wave after every other wave in deploy/, so a canary or a rollback holds nothing back', async () => {
    const files = (await readdir(DEPLOY, { recursive: true })).filter((f) => f.endsWith('.yaml'));
    const waves: { file: string; wave: number }[] = [];
    let website: number | undefined;
    for (const file of files) {
      for (const doc of parseAllDocuments(await readFile(join(DEPLOY, file), 'utf-8'))) {
        const manifest = doc.toJS() as Manifest | null;
        const wave = manifest?.metadata?.annotations?.[WAVE];
        if (wave === undefined) continue;
        if (manifest?.kind === 'Application' && manifest.metadata?.name === 'website') website = Number(wave);
        else waves.push({ file, wave: Number(wave) });
      }
    }
    expect(website).toBeDefined();
    expect(waves.filter(({ wave }) => wave >= (website ?? 0))).toEqual([]);
  });
});

type Deletes = { key?: string; pattern?: string; action: string }[];

interface Collector {
  config: {
    processors: Record<string, { attributes?: Deletes; actions?: Deletes } & Partial<K8s>>;
    service: { pipelines: Record<string, { processors: string[] }> };
  };
}

interface K8s {
  extract: { metadata: string[]; labels: { tag_name: string }[] };
}

/** A Go regular expression's leading `(?i)` as JavaScript's flag. */
const regexp = (pattern: string) =>
  pattern.startsWith('(?i)') ? new RegExp(pattern.slice(4), 'i') : new RegExp(pattern);

describe('only the collector says which pod a record came from', () => {
  it('deletes what a record claims about its pod before k8s_attributes, in every pipeline that runs it', async () => {
    const { config } = parse(
      await readFile(join(DEPLOY, 'base/telemetry/values/otel-collector.yaml'), 'utf-8'),
    ) as Collector;
    const k8s = config.processors.k8s_attributes as K8s;
    // What k8s_attributes sets on a record's resource, and so what the app must not set there first: it keeps an
    // attribute a record already has.
    const set = [...k8s.extract.metadata, ...k8s.extract.labels.map((l) => l.tag_name)];
    expect(set).toContain('k8s.pod.label.rollouts-pod-template-hash');
    // What the app must not set on a data point either: Prometheus turns every separator into an underscore, and a
    // data point's label goes before its resource's of the same name.
    const spellings = [
      'k8s.pod.label.rollouts-pod-template-hash',
      'k8s_pod_label_rollouts_pod_template_hash',
      'K8S-Pod/label rollouts.pod.template.hash',
    ];

    // A resource processor deletes from a record's resource; an attributes processor from the record itself.
    const deletes = (name: string, kind: 'resource' | 'attributes') => {
      const processor = config.processors[name] ?? {};
      const list = kind === 'resource' ? processor.attributes : processor.actions;
      return name.startsWith(`${kind}/`) ? (list ?? []).filter((a) => a.action === 'delete') : [];
    };
    const deleted = (name: string, kind: 'resource' | 'attributes', attribute: string) =>
      deletes(name, kind).some(
        (a) => a.key === attribute || (a.pattern !== undefined && regexp(a.pattern).test(attribute)),
      );

    const pipelines = Object.entries(config.service.pipelines).filter(([, p]) =>
      p.processors.includes('k8s_attributes'),
    );
    expect(pipelines.map(([name]) => name).sort()).toEqual(['logs', 'metrics', 'traces']);
    for (const [name, { processors }] of pipelines) {
      const before = processors.slice(0, processors.indexOf('k8s_attributes'));
      for (const attribute of set) {
        expect(
          before.some((p) => deleted(p, 'resource', attribute)),
          `${name}: ${attribute} deleted from the resource first`,
        ).toBe(true);
      }
      for (const attribute of spellings) {
        expect(
          before.some((p) => deleted(p, 'attributes', attribute)),
          `${name}: ${attribute} deleted from the record first`,
        ).toBe(true);
      }
    }
  });
});
