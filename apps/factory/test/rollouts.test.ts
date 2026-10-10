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

interface Collector {
  config: {
    processors: Record<string, { attributes?: { key?: string; pattern?: string; action: string }[] } & Partial<K8s>>;
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
    const k8s = config.processors.k8s_attributes as K8s;
    // What k8s_attributes sets, and so what the app must not set first: it keeps an attribute a record already has.
    const set = [...k8s.extract.metadata, ...k8s.extract.labels.map((l) => l.tag_name)];
    expect(set).toContain('k8s.pod.label.rollouts-pod-template-hash');

    // A resource processor's deletes: what an attributes processor deletes is a record's own, not its resource's.
    const deletes = (name: string) =>
      name.startsWith('resource')
        ? (config.processors[name]?.attributes ?? []).filter((a) => a.action === 'delete')
        : [];
    const deleted = (name: string, attribute: string) =>
      deletes(name).some(
        (a) => a.key === attribute || (a.pattern !== undefined && new RegExp(a.pattern).test(attribute)),
      );

    const pipelines = Object.entries(config.service.pipelines).filter(([, p]) =>
      p.processors.includes('k8s_attributes'),
    );
    expect(pipelines.map(([name]) => name).sort()).toEqual(['logs', 'metrics', 'traces']);
    for (const [name, { processors }] of pipelines) {
      const before = processors.slice(0, processors.indexOf('k8s_attributes'));
      for (const attribute of set) {
        expect(
          before.some((p) => deleted(p, attribute)),
          `${name}: ${attribute} deleted first`,
        ).toBe(true);
      }
    }
  });
});
