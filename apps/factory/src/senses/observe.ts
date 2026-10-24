/**
 * The probes and the crawler, run once against any copy of the app, and what each check saw. The journeys gate runs
 * them against a pull request's base and its change (`commands/gate.ts`), and Verify runs a ticket's check again
 * against the stable Service (`probes/verify.ts`). Given the checks wanted again, it runs only the probes that made
 * them, and the crawl only when one of its checks is among them: a crawl cannot look at one route alone.
 *
 * Each probe also answers `<probe>/device`: whether its pages left anything on the device that no probe before it in
 * the pass had, a cookie or anything a script stores, or asked another origin. The app keeps nothing on a visitor's
 * device and loads nothing from anywhere else, so the gate fails a change that starts to, as it fails any check that
 * passes on the base and fails on the change. The probes that look after the live app do not ask.
 */
import type { ArtifactStore } from '@software-factory/store';
import { Crawler } from '../crawler/index.ts';
import { type Seen, toRunAgain } from '../gates/journeys.ts';
import { PROBES, probes } from '../probes/index.ts';
import { UNMEASURED, versionOf } from './http.ts';
import type { Device, Observation, Sense } from './types.ts';

export interface ObserveOptions {
  store: ArtifactStore;
  log: { warn(fields: object, message: string): void };
  /** The most resources a crawl asks for. */
  limit: number;
}

/**
 * Runs the senses against the app at `url`, or only those that make `only`, and says what each check saw, with the
 * version the app ran before and after: `after` differs, or is null when the app did not say, when a release came
 * between and what was seen may be of either.
 */
export async function observeApp(
  url: string,
  only: readonly Pick<Seen, 'sense' | 'check'>[] | undefined,
  { store, log, limit }: ObserveOptions,
): Promise<{ version: string; seen: Seen[]; after: string | null }> {
  const app = url.replace(/\/$/, '');
  const version = await versionOf(app, UNMEASURED);
  const again = only && toRunAgain(only);
  const senses: Array<Sense & { close(): Promise<void> }> = [
    ...(!again || again.probes.size ? [probes({ app, store, log, device: true })] : []),
    ...(!again || again.crawl ? [new Crawler({ app, store, log, limit })] : []),
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
        if (o.device) seen.push(deviceSeen(sense.name, o, o.device));
      }
    } finally {
      await sense.close();
    }
  }
  const after = await versionOf(app, UNMEASURED).catch(() => null);
  return { version, seen, after };
}

/** What a probe's pages left on the device and asked of other origins, as a check of its own. */
function deviceSeen(sense: Seen['sense'], o: Observation, { kept, asked }: Device): Seen {
  const said = [
    ...(kept.length ? [`left ${list(kept)} on the device`] : []),
    ...(asked.length ? [`asked ${list(asked)}`] : []),
  ];
  return {
    sense,
    check: `${o.check}/device`,
    route: o.route,
    failed: said.length > 0,
    ...(said.length ? { message: `The pages ${said.join(', and ')}.` } : {}),
  };
}

const list = (things: string[]) =>
  things.length > 5 ? `${things.slice(0, 5).join(', ')} and ${things.length - 5} more` : things.join(', ');
