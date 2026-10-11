/**
 * `factory gate`: the gates that need the factory's senses, run in the app's CI from the `factory-browser` image at
 * the digest this repository pins (`.github/workflows/app-gates.yml`).
 *
 *     factory gate journeys --base <url> --change <url> [--summary <file>]
 *
 * `journeys` runs the probes and the crawler against the base's app and the change's, and fails on a check that
 * passes on the base and fails on the change twice (`gates/journeys.ts`). It observes the two apps at once; the second
 * time, it runs only the probes that failed, and the crawl only when one of its checks did. It writes its summary as
 * Markdown to the file, or prints it. CRAWL_LIMIT caps the crawl, 150 by default. With COMPARISON_FILE set, it also
 * writes the checks that regressed there as JSON (`comparisonMessage`): the canary's analysis sets it to the Job's
 * termination message, which the line reads when the journeys fail a release.
 */
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DiskArtifacts } from '@software-factory/store';
import { compareJourneys, comparisonMessage, type Observe, summary } from '../gates/journeys.ts';
import { annotate } from '../gates/report.ts';
import { log } from '../log.ts';
import { observeApp } from '../senses/observe.ts';

export const USAGE = '  factory gate journeys --base <url> --change <url> [--summary <file>]';

export async function run(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { base: { type: 'string' }, change: { type: 'string' }, summary: { type: 'string' } },
  });
  if (positionals[0] !== 'journeys' || !values.base || !values.change) {
    console.log(`Usage:\n${USAGE}`);
    return 2;
  }
  const store = new DiskArtifacts(await mkdtemp(join(tmpdir(), 'gate-')));
  const limit = Number(process.env.CRAWL_LIMIT ?? 150);

  const observe: Observe = async (url, only) => (await observeApp(url, only, { store, log, limit })).seen;

  const comparison = await compareJourneys(observe, values.base, values.change);
  const markdown = summary(comparison);
  if (values.summary) await appendFile(values.summary, `${markdown}\n`);
  else console.log(markdown);
  if (process.env.COMPARISON_FILE) await writeFile(process.env.COMPARISON_FILE, comparisonMessage(comparison));
  for (const r of comparison.regressions)
    annotate('error', `${r.sense} ${r.check} on ${r.route}: ${r.message ?? r.trouble ?? 'failed'}`);
  return comparison.regressions.length ? 1 : 0;
}
