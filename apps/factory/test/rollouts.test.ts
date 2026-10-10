import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

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
