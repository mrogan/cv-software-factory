/**
 * Triage's look at what the senses read besides the app (`ENVIRONMENT` in policy/triage.ts): whether Prometheus
 * scrapes the targets the senses read and still takes metrics over OTLP, whether Loki and Tempo still store what they
 * are sent, and whether the cluster's volumes have room. Each is asked as of a time, so a look taken after a signal
 * waited in the inbox says how things stood when the sense saw it.
 *
 * Only the backends it has an address for are looked at, and the disk is read through Prometheus. A backend that
 * cannot be asked, or has no measure, is neither healthy nor not (`healthy: null`), which triage counts as not seen to
 * be healthy. A look is kept for its minute, so a burst of signals asks once, unless a backend did not answer.
 *
 * "Still storing" is asked as "stored something lately", never as "answers": a Loki on a full disk answers every
 * query, and returns nothing.
 */
import { cutTo, type Dependency, type Environment } from '@software-factory/events';
import { ENVIRONMENT } from '../../../policy/triage.ts';
import type { Loki } from './clients/loki.ts';
import type { Prometheus } from './clients/prometheus.ts';
import type { Tempo } from './clients/tempo.ts';

type Reading = Environment['dependencies'][number];

export interface Backends {
  prometheus?: Prometheus | undefined;
  loki?: Loki | undefined;
  tempo?: Tempo | undefined;
}

/** Looks kept, one a minute: enough for signals that waited a while in the inbox. */
const KEPT = 10;

/** A look at the backends given, as of a time, or nothing when none is given. */
export function environmentLook(backends: Backends): ((at: Date) => Promise<Environment>) | undefined {
  const { prometheus, loki, tempo } = backends;
  const checks: [Dependency, (at: Date) => Promise<Omit<Reading, 'name'>>][] = [];
  if (prometheus) {
    checks.push(['prometheus', (at) => scraping(prometheus, at)], ['disk', (at) => disk(prometheus, at)]);
  }
  if (loki) checks.push(['loki', (at) => storingLogs(loki, at)]);
  if (tempo) checks.push(['tempo', (at) => storingTraces(tempo, at)]);
  if (!checks.length) return undefined;
  const kept = new Map<number, Promise<Environment>>();
  return (at) => {
    const minute = Math.floor(at.getTime() / 60_000);
    let look = kept.get(minute);
    if (!look) {
      let unasked = false;
      look = Promise.all(
        checks.map(async ([name, check]) => {
          // Asked twice before it counts as not answering, so one dropped request holds nothing.
          const reading = await check(at)
            .catch(() => check(at))
            .catch((error: unknown) => {
              unasked = true;
              return { healthy: null, saw: `could not ask: ${error instanceof Error ? error.message : String(error)}` };
            });
          return { name, ...reading, saw: cutTo(reading.saw, 160) };
        }),
      ).then((dependencies) => {
        // A look with a backend that did not answer is not kept: the next signal asks again.
        if (unasked && kept.get(minute) === look) kept.delete(minute);
        return { at: at.toISOString(), dependencies };
      });
      kept.set(minute, look);
      for (const old of kept.keys()) if (kept.size > KEPT) kept.delete(old);
    }
    return look;
  };
}

/**
 * Each target the senses read (`ENVIRONMENT.targets`) is there and answered its last scrape, and metrics still arrive
 * over OTLP. A target down is named by its namespace and pod, or its instance, so a hold says which.
 */
async function scraping(prometheus: Prometheus, at: Date): Promise<Omit<Reading, 'name'>> {
  const up = await prometheus.instant('up', at);
  if (!up.length) return { healthy: false, saw: 'no scrape stored at the time, not even of itself' };
  const read = Object.entries(ENVIRONMENT.targets).map(([name, labels]) => ({
    name,
    targets: up.filter((target) => Object.entries(labels).every(([label, value]) => target.labels[label] === value)),
  }));
  const counted = new Set(read.flatMap(({ targets }) => targets));
  const missing = read.filter(({ targets }) => !targets.length).map(({ name }) => `no ${name} target`);
  const down = read.flatMap(({ name, targets }) =>
    targets.filter((target) => target.value !== 1).map((target) => `${name} ${where(target.labels)}`),
  );
  const others = up.filter((target) => !counted.has(target) && target.value !== 1).length;
  const ofTheRest = others ? ` (${others} of the rest down)` : '';
  const [otlp] = await prometheus.instant('count(target_info)', at);
  const arriving = otlp?.value
    ? `metrics arriving over OTLP from ${otlp.value} services`
    : 'no metrics arriving over OTLP';
  if (missing.length || down.length) {
    const problems = [...missing, ...(down.length ? [`down: ${down.join(', ')}`] : [])].join('; ');
    // What is down first, so the clip leaves it whole as far as it can.
    return { healthy: false, saw: `${problems}; ${arriving}${ofTheRest}` };
  }
  const targets = `the ${counted.size} targets the senses read up${ofTheRest}`;
  return otlp?.value
    ? { healthy: true, saw: `${targets}, and ${arriving}` }
    : { healthy: false, saw: `${targets}, but ${arriving}` };
}

/** Where a target is: its namespace and pod when it is a pod's, or else its instance (a node, for the kubelet). */
function where(labels: Record<string, string>): string {
  const { namespace, pod, instance } = labels;
  return namespace && pod ? `${namespace}/${pod}` : (instance ?? '?');
}

/**
 * Loki stored a record sent over OTLP within the last few minutes. Not the pod log collector's, which reach Loki by a
 * way of their own (deploy/base/pod-logs) and would keep it looking healthy when nothing else arrives.
 */
async function storingLogs(loki: Loki, at: Date): Promise<Omit<Reading, 'name'>> {
  const minutes = ENVIRONMENT.lokiMinutes;
  const [stored] = await loki.instant(
    `sum(count_over_time({service_name=~".+", service_name!="pod-logs"}[${minutes}m]))`,
    at,
  );
  const records = stored?.value ?? 0;
  return records > 0
    ? { healthy: true, saw: `${records} records stored in the ${minutes} minutes before` }
    : { healthy: false, saw: `no record stored from anything in the ${minutes} minutes before` };
}

/** Tempo stored a trace from anything within the last few minutes. */
async function storingTraces(tempo: Tempo, at: Date): Promise<Omit<Reading, 'name'>> {
  const minutes = ENVIRONMENT.tempoMinutes;
  const stored = await tempo.anyTrace(new Date(at.getTime() - minutes * 60_000), at);
  return stored
    ? { healthy: true, saw: `traces stored in the ${minutes} minutes before` }
    : { healthy: false, saw: `no trace stored from anything in the ${minutes} minutes before` };
}

/** The fullest of the volumes the cluster's pods keep has room. */
async function disk(prometheus: Prometheus, at: Date): Promise<Omit<Reading, 'name'>> {
  const [fullest] = await prometheus.instant(
    'bottomk(1, kubelet_volume_stats_available_bytes / kubelet_volume_stats_capacity_bytes)',
    at,
  );
  if (!fullest) return { healthy: null, saw: 'no measure of the cluster’s volumes' };
  const { namespace, persistentvolumeclaim: claim } = fullest.labels;
  const which = namespace && claim ? ` (${namespace}/${claim})` : '';
  const free = `${Math.floor(fullest.value * 100)}% free`;
  return { healthy: fullest.value >= ENVIRONMENT.diskFree, saw: `the fullest volume${which} ${free}` };
}
