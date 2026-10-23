import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEPLOY, manifests } from './deploy.ts';

/** How deploy/ fits the app's canary in: when root syncs the website, and who says which version a record is from. */
const WAVE = 'argocd.argoproj.io/sync-wave';

interface Manifest {
  kind?: string;
  metadata?: { name?: string; annotations?: Record<string, string> };
}

describe('the website syncs last', () => {
  it('in a wave after every other wave in deploy/, so a canary or a rollback holds nothing back', async () => {
    const waves: { file: string; wave: number }[] = [];
    let website: number | undefined;
    for (const { file, manifest } of await manifests<Manifest>()) {
      const wave = manifest.metadata?.annotations?.[WAVE];
      if (wave === undefined) continue;
      if (manifest.kind === 'Application' && manifest.metadata?.name === 'website') website = Number(wave);
      else waves.push({ file, wave: Number(wave) });
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

describe('only the collector says which pod a record came from', () => {
  it('deletes what a record claims about its pod before k8s_attributes, in every pipeline that runs it', async () => {
    const { config } = parse(
      await readFile(join(DEPLOY, 'base/telemetry/values/otel-collector.yaml'), 'utf-8'),
    ) as Collector;
    // Each k8s_attributes processor: the app's, and the factory's, which marks the line's counts (provenance.ts).
    const stampers = Object.keys(config.processors).filter((name) => /^k8s_attributes(\/|$)/.test(name));
    expect(stampers.sort()).toEqual(['k8s_attributes', 'k8s_attributes/factory']);
    // What each sets on a record's resource, and so what no sender may set there first: it keeps an attribute a record
    // already has.
    const sets = Object.fromEntries(
      stampers.map((name) => {
        const k8s = config.processors[name] as K8s;
        return [name, [...k8s.extract.metadata, ...k8s.extract.labels.map((l) => l.tag_name)]];
      }),
    );
    expect(sets.k8s_attributes).toContain('k8s.pod.label.rollouts-pod-template-hash');
    expect(sets['k8s_attributes/factory']).toEqual(['k8s.namespace.name', 'k8s.pod.label.app.kubernetes.io/name']);
    // What the app must not set on a data point either: Prometheus turns every character but an ASCII letter or digit
    // into an underscore (ſ and the Kelvin sign too), and a data point's label goes before its resource's of the same name.
    const spellings = [
      'k8s.pod.label.rollouts-pod-template-hash',
      'k8s_pod_label_rollouts_pod_template_hash',
      'k8s-pod/label rollouts.pod.template.hash',
      'k8s\u017fpod_label_rollouts_pod_template_hash',
      'k8s\u212apod_label_rollouts_pod_template_hash',
      'k8s_namespace_name',
      'k8s_pod_label_app_kubernetes_io_name',
      'k8s.pod.label.app.kubernetes.io/name',
    ];

    // A resource processor deletes from a record's resource; an attributes processor from the record itself.
    const deletes = (name: string, kind: 'resource' | 'attributes') => {
      const processor = config.processors[name] ?? {};
      const list = kind === 'resource' ? processor.attributes : processor.actions;
      return name.startsWith(`${kind}/`) ? (list ?? []).filter((a) => a.action === 'delete') : [];
    };
    const deleted = (name: string, kind: 'resource' | 'attributes', attribute: string) =>
      deletes(name, kind).some(
        (a) => a.key === attribute || (a.pattern !== undefined && new RegExp(a.pattern).test(attribute)),
      );

    const pipelines = Object.entries(config.service.pipelines).filter(([, p]) =>
      p.processors.some((processor) => stampers.includes(processor)),
    );
    expect(pipelines.map(([name]) => name).sort()).toEqual(['logs', 'metrics', 'traces']);
    for (const [name, { processors }] of pipelines) {
      const first = Math.min(...stampers.map((s) => processors.indexOf(s)).filter((i) => i >= 0));
      const before = processors.slice(0, first);
      const set = stampers.filter((s) => processors.includes(s)).flatMap((s) => sets[s] ?? []);
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
