/**
 * `factory gate`: the gates that need the factory's senses, run in the app's CI from the `factory-browser` image at
 * the digest this repository pins (`.github/workflows/app-gates.yml`).
 *
 *     factory gate journeys --base <url> --change <url> [--summary <file>]
 *
 * `journeys` runs the probes and the crawler against the base's app and the change's, and fails on a check that
 * passes on the base and fails on the change twice (`gates/journeys.ts`). It writes its summary as Markdown to the
 * file, or prints it. CRAWL_LIMIT caps the crawl, 150 by default.
 */
import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { DiskArtifacts } from '@software-factory/store';
import { Crawler } from '../crawler/index.ts';
import { compareJourneys, type Seen, summary } from '../gates/journeys.ts';
import { log } from '../log.ts';
import { probes } from '../probes/index.ts';
import { versionOf } from '../senses/http.ts';

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

  const observe = async (url: string): Promise<Seen[]> => {
    const app = url.replace(/\/$/, '');
    const version = await versionOf(app);
    const seen: Seen[] = [];
    for (const sense of [probes({ app, store, log }), new Crawler({ app, store, log, limit })]) {
      try {
        for (const o of await sense.pass(version)) {
          seen.push({
            sense: sense.name,
            check: o.check,
            route: o.route,
            failed: o.finding !== null && !o.trouble,
            ...(o.trouble ? { trouble: o.trouble } : {}),
            ...(o.finding ? { message: o.finding.message } : {}),
          });
        }
      } finally {
        await sense.close();
      }
    }
    return seen;
  };

  const comparison = await compareJourneys(observe, values.base, values.change);
  const markdown = summary(comparison);
  if (values.summary) await appendFile(values.summary, `${markdown}\n`);
  else console.log(markdown);
  for (const r of comparison.regressions)
    console.log(`::error::${r.sense} ${r.check} on ${r.route}: ${r.message ?? 'failed'}`);
  return comparison.regressions.length ? 1 : 0;
}
