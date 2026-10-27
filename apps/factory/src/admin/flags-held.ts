/**
 * Whether the app holds the flags as Martin set them. flagd's readiness follows its first read of `flags`, not its
 * watch, so a watch broken after start leaves it ready and serving the last flags it read, and a kill switch would not
 * reach the app. The app tells a marked request the revision of the flag set it holds (`x-flags-revision`,
 * docs/COMPONENTS/FEATURE-FLAGS.md), so this asks it, from outside, and compares it with the revision in `flags`.
 *
 * - **Every pod, every minute.** The app's pods are the ready endpoints of its Rollout's stable and canary Services,
 *   read through the admin service's own Roles (the Rollout, by name; the EndpointSlices in the app's namespace, which
 *   Kubernetes names by generated names, so they are listed). Each is asked at its own address, never through a
 *   Service, which would answer from one pod of several: `GET /health`, with the mark (`x-unmeasured`), which the app
 *   keeps no record of, for the header alone.
 * - **How long it has differed,** as one figure for the app: from the first check in an unbroken run that did not find
 *   every pod holding the revision in `flags`, or from a write of `flags`, whichever came first, until one does. So a
 *   pod that differs, goes, and another that differs, never starts the count again. `flags` holding no revision is
 *   the app saying `none`: not a difference.
 * - **A check that cannot ask** (no `flags`, no Rollout, no ready pod, a pod that does not answer or answers without the
 *   header) is no proof the app holds them: the count goes on, and the figures say it could not ask.
 * - **After a narrowing or Off,** written through `FlagStages`, it asks every ten seconds for two minutes, and counts
 *   from that write until a check finds the app holding the flags as set: past a minute, Martin is paged.
 *
 * Its figures are gauges the SDK reads each time it collects (`observeHeld`), which Prometheus's rules judge
 * (`apps/factory/src/alerts/rules.ts`); its view is public (`GET /admin/flags/held`), with no pod's address or name.
 */
import { type BatchObservableResult, metrics } from '@opentelemetry/api';
import type { Logger } from 'pino';
import { z } from 'zod';
import { FLAGS_HELD, REVISION, REVISION_FLAG, readFlags } from '../../../../policy/flags.ts';
import type { RolloutRef } from '../release/rollout-ref.ts';
import type { Kube } from '../runners/kube.ts';
import { UNMEASURED } from '../senses/http.ts';
import { featureFlagPath } from './flags.ts';

/** How often it asks, how long it waits for a pod, and the minute the app has to take a narrowing. */
export const HELD = {
  everyMs: 60_000,
  /** After a write of `flags`, it asks this often, for `afterWriteMs`. */
  soonMs: 10_000,
  afterWriteMs: 120_000,
  timeoutMs: 5_000,
  /** How long the app has to take a change before it is said to lag, and a narrowing pages Martin. */
  takeMs: FLAGS_HELD.takeSeconds * 1000,
} as const;

/** What the app answers a marked request with, when it holds no revision, and one it cannot read. */
const NONE = 'none';
const INVALID = 'invalid';

/** How far back a narrowing written before a restart is still counted: past it, the five minutes' alert has it. */
const RESTORE_MS = 5 * 60_000;

/** The port the app serves on, which its fence lets the admin service reach. */
const APP_PORT = 8080;

/** The header the app tells a marked request its flag set's revision in. */
export const REVISION_HEADER = 'x-flags-revision';

/** One of the app's pods, as its Services' EndpointSlices give it: its address, its port, and its name, for the log. */
export interface Pod {
  address: string;
  port: number;
  name: string;
}

/** Asks one pod for the revision it holds: the header's value, or undefined when it does not answer with one. */
export type Ask = (pod: Pod, signal: AbortSignal) => Promise<string | undefined>;

/** Whether the app holds the flags as set, as anyone may read it. */
export interface HeldView {
  /**
   * `held`: every pod holds the revision in `flags`. `taking`: not yet, within a minute of the first sign. `lagging`:
   * not for a minute or more. `unchecked`: the last check could not ask every pod, or none has been made.
   */
  state: 'held' | 'taking' | 'lagging' | 'unchecked';
  /** The revision `flags` holds, or null when it holds none, or has not been read. */
  revision: string | null;
  /** What the app's pods answered, each once: a revision, or `none`, `stale` or `invalid`. */
  held: string[];
  /** When it was first seen not to hold them, in this run; null while it does. */
  since: string | null;
  /** When it was last asked; null before the first check. */
  checkedAt: string | null;
}

/** The gauges' values: how long it has differed, and since a narrowing, in seconds; whether it could ask; whether set. */
export interface HeldFigures {
  differing: number;
  narrowing: number;
  checked: 0 | 1;
  set: 0 | 1;
}

const rolloutServices = z.looseObject({
  spec: z.looseObject({
    strategy: z
      .looseObject({
        canary: z
          .looseObject({ stableService: z.string().optional(), canaryService: z.string().optional() })
          .optional(),
      })
      .optional(),
  }),
});

const endpointSlices = z.looseObject({
  items: z.array(
    z.looseObject({
      addressType: z.string(),
      ports: z
        .array(
          z.looseObject({
            port: z.number().int().nullish(),
            protocol: z.string().nullish(),
            name: z.string().nullish(),
          }),
        )
        .nullish(),
      endpoints: z
        .array(
          z.looseObject({
            addresses: z.array(z.string()),
            conditions: z.looseObject({ ready: z.boolean().nullish(), terminating: z.boolean().nullish() }).nullish(),
            targetRef: z.looseObject({ name: z.string().optional() }).nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

const featureFlag = z.looseObject({ spec: z.unknown() });

/** One check: what `flags` holds, and what each pod answered. */
interface Check {
  at: number;
  /** The revision in `flags`; undefined when it holds none. Unread when `flags` could not be read. */
  revision: string | undefined;
  read: boolean;
  answers: (string | undefined)[];
  /** Whether it asked every ready pod, and each answered with the header. */
  checked: boolean;
  /** Whether every pod held the revision in `flags`. */
  holds: boolean;
}

/** Asks a pod at its own address, with the mark, for `/health`, and reads the header alone. */
export const askPod: Ask = async (pod, signal) => {
  const host = pod.address.includes(':') ? `[${pod.address}]` : pod.address;
  const response = await fetch(`http://${host}:${pod.port}/health`, {
    headers: UNMEASURED,
    redirect: 'manual',
    signal,
  });
  await response.body?.cancel();
  return response.headers.get(REVISION_HEADER) ?? undefined;
};

export class FlagsHeld {
  readonly #kube: Kube;
  readonly #flags: string;
  readonly #rollout: string;
  readonly #namespace: string;
  readonly #log: Logger;
  readonly #ask: Ask;
  readonly #now: () => number;

  #last: Check | undefined;
  /** Whether `flags` held a revision when last read. */
  #set = false;
  /** The first sign, in this run, that the app does not hold the flags as set. */
  #since: number | undefined;
  /** A narrowing or Off from before this start, not yet known taken or not. */
  #restored: number | undefined;
  /** The earliest narrowing or Off the app has not been seen to take. */
  #narrowed: number | undefined;
  /** The last write of `flags`, which the checks follow sooner for a while. */
  #written: number | undefined;
  /** Writes so far: a check that began before one cannot say the app took it. */
  #writes = 0;
  #failing = false;
  /** Why the check last could not ask, said once. */
  #told: string | undefined;
  /** When the next check is due, so a burst of writes does not keep putting it off. */
  #due: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = true;

  constructor({
    kube,
    flags,
    rollout,
    log,
    ask = askPod,
    now = Date.now,
  }: { kube: Kube; flags: RolloutRef; rollout: RolloutRef; log: Logger; ask?: Ask; now?: () => number }) {
    this.#kube = kube;
    this.#flags = featureFlagPath(flags);
    this.#rollout =
      `/apis/argoproj.io/v1alpha1/namespaces/${encodeURIComponent(rollout.namespace)}` +
      `/rollouts/${encodeURIComponent(rollout.name)}`;
    this.#namespace = rollout.namespace;
    this.#log = log;
    this.#ask = ask;
    this.#now = now;
  }

  /** Checks now, and every minute after, until stopped. */
  start(): void {
    this.#stopped = false;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
  }

  /**
   * `flags` was written: the app has not taken it yet, and is asked again soon. A narrowing or Off starts the minute
   * it has to take it.
   */
  written(narrowed: boolean): void {
    const now = this.#now();
    this.#writes += 1;
    this.#written = now;
    this.#since ??= now;
    if (narrowed) this.#narrowed ??= now;
    const due = Date.now() + HELD.soonMs / 2;
    if (!this.#stopped && !this.#running && (this.#due === undefined || this.#due > due)) {
      this.#schedule(HELD.soonMs / 2);
    }
  }

  /**
   * A narrowing or Off written before the service started (as `flag.staged` records it), whose minute a restart would
   * otherwise forget. The app may have taken it before the restart, which nothing here knew, so it counts only once a
   * check that asked every pod finds the app not holding the flags as set: then from its write. A check that holds
   * them forgets it, and one that cannot ask says nothing of it. Only one written within the last few minutes, so an
   * old one never pages for a difference that came later.
   */
  narrowedBefore(at: number): void {
    if (this.#now() - at > RESTORE_MS) return;
    this.#restored = Math.min(this.#restored ?? at, at);
    this.#written ??= at;
  }

  /** Asks the app once, and keeps what it found. */
  async check(): Promise<void> {
    const writes = this.#writes;
    const check = await this.#look();
    this.#last = check;
    if (check.read) this.#set = check.revision !== undefined;
    if (check.checked && this.#restored !== undefined) {
      if (!check.holds) this.#narrowed = Math.min(this.#narrowed ?? this.#restored, this.#restored);
      this.#restored = undefined;
    }
    if (check.holds && writes === this.#writes) {
      this.#since = undefined;
      this.#narrowed = undefined;
      this.#written = undefined;
    } else if (!check.holds) {
      this.#since ??= check.at;
    }
  }
  /** The figures the gauges report, or none before the first check. */
  figures(): HeldFigures | undefined {
    const last = this.#last;
    if (!last) return undefined;
    const now = this.#now();
    const seconds = (from: number | undefined) => (from === undefined ? 0 : Math.max(0, (now - from) / 1000));
    return {
      differing: seconds(this.#since),
      narrowing: seconds(this.#narrowed),
      checked: last.checked ? 1 : 0,
      set: this.#set ? 1 : 0,
    };
  }

  /** What anyone may read: no pod's address or name. */
  view(): HeldView {
    const last = this.#last;
    const since = this.#since;
    const state: HeldView['state'] = !last?.checked
      ? 'unchecked'
      : since === undefined
        ? 'held'
        : this.#now() - since < HELD.takeMs
          ? 'taking'
          : 'lagging';
    return {
      state,
      revision: last?.read ? (last.revision ?? null) : null,
      held: [...new Set(last?.answers.filter((a): a is string => a !== undefined) ?? [])].sort(),
      since: since === undefined ? null : new Date(since).toISOString(),
      checkedAt: last ? new Date(last.at).toISOString() : null,
    };
  }

  #schedule(ms: number): void {
    clearTimeout(this.#timer);
    this.#due = Date.now() + ms;
    this.#timer = setTimeout(() => void this.#tick(), ms);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    if (this.#stopped) return;
    this.#running = this.check().catch((error: unknown) => {
      this.#log.error({ err: error }, 'could not check whether the app holds the flags');
    });
    await this.#running;
    this.#running = undefined;
    if (this.#stopped) return;
    const soon = this.#written !== undefined && this.#now() - this.#written < HELD.afterWriteMs;
    this.#schedule(soon ? HELD.soonMs : HELD.everyMs);
  }

  /**
   * One check: `flags`, the app's pods, and each pod's answer. A failure to read, or a revision in `flags` of a shape
   * the admin service cannot read, which the app may still tell, is a check that could not compare.
   */
  async #look(): Promise<Check> {
    const at = this.#now();
    let revision: string | undefined;
    let read = false;
    let pods: Pod[] = [];
    try {
      const [flags, found] = await Promise.all([this.#kube.get(this.#flags, featureFlag), this.#pods()]);
      if (flags) {
        const held = readFlags(flags.spec);
        revision = held.revision;
        read = !held.outside.includes(REVISION_FLAG);
        if (!read)
          this.#once(
            'unreadable',
            { revision: REVISION_FLAG },
            '`flags` holds a revision of a shape no write of ours makes',
          );
      }
      pods = found;
    } catch (error) {
      this.#once('unread', { err: error }, 'could not read the flags or find the app’s pods');
      return { at, revision, read, answers: [], checked: false, holds: false };
    }
    const unanswered: string[] = [];
    const answers = await Promise.all(
      pods.map((pod) =>
        this.#ask(pod, AbortSignal.timeout(HELD.timeoutMs)).then(
          // Anyone may read what the pods answered, so an answer no revision could be is told as `invalid`, as the
          // app tells a revision it cannot read.
          (answer) => {
            if (answer === undefined) unanswered.push(pod.name);
            return answer === undefined || REVISION.test(answer) ? answer : INVALID;
          },
          (error: unknown) => {
            unanswered.push(pod.name);
            if (!this.#failing) this.#log.warn({ err: error, pod: pod.name }, 'a pod of the app did not answer');
            return undefined;
          },
        ),
      ),
    );
    if (pods.length === 0) this.#once('no-pods', { read }, 'found no ready pod of the app to ask');
    else if (unanswered.length)
      this.#once('unanswered', { pods: unanswered }, 'pods of the app did not say which flags they hold');
    const checked = read && pods.length > 0 && unanswered.length === 0;
    const expected = revision ?? NONE;
    const holds = checked && answers.every((answer) => answer === expected);
    if (checked && this.#failing) this.#log.info('asking the app which flags it holds again');
    this.#failing = !checked;
    if (checked) this.#told = undefined;
    if (checked && !holds) {
      this.#log.warn(
        { expected, held: pods.map((pod, i) => ({ pod: pod.name, revision: answers[i] })) },
        'the app does not hold the flags as set',
      );
    }
    return { at, revision, read, answers, checked, holds };
  }

  /** Logs why a check could not ask once, until it can again or the reason changes, not every ten seconds. */
  #once(why: string, context: object, message: string): void {
    this.#failing = true;
    if (this.#told === why) return;
    this.#told = why;
    this.#log.warn(context, message);
  }

  /** The ready pods behind the app's Rollout's stable and canary Services, each once, at the port the app serves on. */
  async #pods(): Promise<Pod[]> {
    const rollout = await this.#kube.get(this.#rollout, rolloutServices);
    const canary = rollout?.spec.strategy?.canary;
    const services = [...new Set([canary?.stableService, canary?.canaryService].filter((s) => s))] as string[];
    const lists = await Promise.all(
      services.map((service) =>
        this.#kube.get(
          `/apis/discovery.k8s.io/v1/namespaces/${encodeURIComponent(this.#namespace)}/endpointslices` +
            `?labelSelector=${encodeURIComponent(`kubernetes.io/service-name=${service}`)}`,
          endpointSlices,
        ),
      ),
    );
    const pods = new Map<string, Pod>();
    for (const slice of lists.flatMap((list) => list?.items ?? [])) {
      if (slice.addressType !== 'IPv4' && slice.addressType !== 'IPv6') continue;
      // The app's own port, the one its fence and the admin service's let through, and no other: a slice without it
      // has no pod to ask, which leaves the check unable to ask rather than reading another server's header.
      const port = (slice.ports ?? []).find((p) => (p.protocol ?? 'TCP') === 'TCP' && p.port === APP_PORT)?.port;
      if (!port) continue;
      for (const endpoint of slice.endpoints ?? []) {
        // Kubernetes says to read a ready condition it does not know as ready; one shutting down is not.
        if (endpoint.conditions?.ready === false || endpoint.conditions?.terminating === true) continue;
        const address = endpoint.addresses[0];
        // A pod once, by its name, though a dual-stack cluster lists it in a slice of each family.
        const name = endpoint.targetRef?.name ?? address;
        if (!address || !name || pods.has(name)) continue;
        pods.set(name, { address, port, name });
      }
    }
    return [...pods.values()];
  }
}

const meter = metrics.getMeter('factory-admin');

const differing = meter.createObservableGauge('admin.flags.differing', {
  description:
    'How long the app has not been seen to hold the flags as set in `flags`, on every pod: 0 while it is, counting on while the admin service cannot ask',
  unit: 's',
});

const narrowing = meter.createObservableGauge('admin.flags.narrowing', {
  description:
    'How long since the earliest narrowing or Off of a flag the app has not been seen to take: 0 when none waits',
  unit: 's',
});

const checked = meter.createObservableGauge('admin.flags.checked', {
  description: 'Whether the last check asked every ready pod of the app, and each answered: 1 if so, 0 if not',
});

const set = meter.createObservableGauge('admin.flags.set', {
  description: 'Whether `flags` held a flag set, a revision, when last read: 1 if it did, 0 if not',
});

/** Reports the figures each time the SDK collects, until the function it gives back is called. */
export function observeHeld(held: FlagsHeld): () => void {
  const observed = [differing, narrowing, checked, set];
  const callback = (result: BatchObservableResult) => {
    const figures = held.figures();
    if (!figures) return;
    result.observe(differing, figures.differing);
    result.observe(narrowing, figures.narrowing);
    result.observe(checked, figures.checked);
    result.observe(set, figures.set);
  };
  meter.addBatchObservableCallback(callback, observed);
  return () => meter.removeBatchObservableCallback(callback, observed);
}
