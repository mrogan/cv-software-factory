/**
 * The image scan gate: Trivy's findings on the change's image, less those already on the base's. The app's image
 * may carry known vulnerabilities in its base image or dependencies that no change made; a change fails this gate
 * only for a high or critical vulnerability it brings in.
 *
 *     node apps/factory/src/gates/image-scan.ts <base trivy.json> <change trivy.json>
 *
 * A vulnerability is known by its id and the package it is in, so moving a package to another version that has the
 * same vulnerability brings nothing new.
 */
import { readFile } from 'node:fs/promises';
import { cell, summarise } from './report.ts';

interface Vulnerability {
  VulnerabilityID: string;
  PkgName: string;
  InstalledVersion: string;
  FixedVersion?: string;
  Severity: string;
  Title?: string;
}

interface TrivyReport {
  Results?: { Target: string; Vulnerabilities?: Vulnerability[] | null }[];
}

export const FAILING = new Set(['HIGH', 'CRITICAL']);

const key = (v: Vulnerability) => `${v.VulnerabilityID} ${v.PkgName}`;

export function vulnerabilities(report: TrivyReport): Vulnerability[] {
  const all = (report.Results ?? []).flatMap((r) => r.Vulnerabilities ?? []);
  return [...new Map(all.map((v) => [key(v), v])).values()];
}

export function newIn(base: TrivyReport, change: TrivyReport) {
  const before = new Set(vulnerabilities(base).map(key));
  const after = vulnerabilities(change);
  const added = after.filter((v) => !before.has(key(v)));
  const removed = vulnerabilities(base).filter((v) => !after.some((a) => key(a) === key(v)));
  return { added, failing: added.filter((v) => FAILING.has(v.Severity)), removed, total: after.length };
}

export async function main([basePath, changePath]: string[]): Promise<number> {
  if (!basePath || !changePath) {
    console.error('Usage: image-scan.ts <base trivy.json> <change trivy.json>');
    return 2;
  }
  const read = async (path: string) => JSON.parse(await readFile(path, 'utf-8')) as TrivyReport;
  const { added, failing, removed, total } = newIn(await read(basePath), await read(changePath));
  const rows = added
    .map(
      (v) =>
        `| ${v.Severity} | ${v.VulnerabilityID} | ${cell(v.PkgName)} ${cell(v.InstalledVersion)} | ${cell(v.FixedVersion ?? 'none yet')} | ${cell(v.Title ?? '')} |`,
    )
    .join('\n');
  await summarise(
    [
      '## Image scan',
      failing.length
        ? `This change's image brings in ${failing.length} high or critical vulnerabilit${failing.length === 1 ? 'y' : 'ies'} the base's does not have.`
        : `This change's image brings in no high or critical vulnerability. It has ${total} known in all, ${added.length} of them new and ${removed.length} fewer than the base's.`,
      added.length ? `| Severity | Vulnerability | Package | Fixed in | Title |\n|---|---|---|---|---|\n${rows}` : '',
    ].join('\n\n'),
  );
  for (const v of failing)
    console.log(`::error::${v.Severity} ${v.VulnerabilityID} in ${v.PkgName} ${v.InstalledVersion}`);
  return failing.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
