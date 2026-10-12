/**
 * The probes and the crawler, run once against any copy of the app, and what each check saw. The journeys gate runs
 * them against a pull request's base and its change (`commands/gate.ts`), and Verify runs a ticket's check again
 * against the stable Service (`probes/verify.ts`). Given the checks wanted again, it runs only the probes that made
 * them, and the crawl only when one of its checks is among them: a crawl cannot look at one route alone.
 */
import type { ArtifactStore } from '@software-factory/store';
import { Crawler } from '../crawler/index.ts';
import { type Seen, toRunAgain } from '../gates/journeys.ts';
import { PROBES, probes } from '../probes/index.ts';
import { type RequestHeaders, versionOf } from './http.ts';
import type { Sense } from './types.ts';

export interface ObserveOptions {
  store: ArtifactStore;
  log: { warn(fields: object, message: string): void };
  /** The most resources a crawl asks for. */
  limit: number;
  /** Sent with every request to the app, besides the usual. */
  headers?: RequestHeaders | undefined;
}

/**
 * Runs the senses against the app at `url`, or only those that make `only`, and says what each check saw, with the
 * version the app ran before and after: `after` differs, or is null when the app did not say, when a release came
 * between and what was seen may be of either.
 */
export async function observeApp(
  url: string,
  only: readonly Pick<Seen, 'sense' | 'check'>[] | undefined,
  { store, log, limit, headers }: ObserveOptions,
): Promise<{ version: string; seen: Seen[]; after: string | null }> {
  const app = url.replace(/\/$/, '');
  const version = await versionOf(app, headers);
  const again = only && toRunAgain(only);
  const senses: Array<Sense & { close(): Promise<void> }> = [
    ...(!again || again.probes.size ? [probes({ app, store, log, headers })] : []),
    ...(!again || again.crawl ? [new Crawler({ app, store, log, limit, headers })] : []),
  ];
  const skip = again && new Set(PROBES.map((p) => p.id).filter((id) => !again.probes.has(id)));
  const seen: Seen[] = [];
  for (const sense of senses) {
    try {
      for (const o of await sense.pass(version, skip)) {
        seen.push({
          sense: sense.name,
          check: o.check,
          route: o.route,
          failed: o.finding !== null && !o.trouble,
          ...(o.trouble ? { trouble: o.trouble } : {}),
          ...(o.finding ? { message: o.finding.message, symptom: o.finding.symptom } : {}),
          ...(o.finding?.evidence?.length ? { evidence: o.finding.evidence } : {}),
        });
      }
    } finally {
      await sense.close();
    }
  }
  const after = await versionOf(app, headers).catch(() => null);
  return { version, seen, after };
}
