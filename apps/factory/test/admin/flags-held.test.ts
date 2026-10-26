import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flagsSpec } from '../../../../policy/flags.ts';
import { askPod, FlagsHeld, HELD, type Pod } from '../../src/admin/flags-held.ts';
import type { Kube } from '../../src/runners/kube.ts';

/**
 * The admin service's check that the app holds the flags as set: every ready pod behind the Rollout's two Services,
 * each at its own address, compared with the revision in `flags`, and how long they have differed.
 */
const FLAGS = { namespace: 'flagd', name: 'flags' };
const ROLLOUT = { namespace: 'website', name: 'website' };

interface Endpoint {
  ip: string;
  name: string;
  ready?: boolean | null;
  terminating?: boolean;
}

/** Kubernetes as the admin service's Roles let it read it: `flags`, the app's Rollout, and its Services' slices. */
class AppKube implements Kube {
  revision: string | undefined = 'r3';
  flagsThere = true;
  services: { stableService?: string; canaryService?: string } = {
    stableService: 'website',
    canaryService: 'website-canary',
  };
  slices: Record<string, { addressType?: string; port?: number; endpoints: Endpoint[] }[]> = {
    website: [
      {
        endpoints: [
          { ip: '10.42.0.11', name: 'website-abc-1' },
          { ip: '10.42.0.12', name: 'website-abc-2' },
        ],
      },
    ],
    'website-canary': [{ endpoints: [{ ip: '10.42.0.11', name: 'website-abc-1' }] }],
  };
  failing: Error | undefined;
  readonly paths: string[] = [];

  async get<T>(path: string, schema: { parse(v: unknown): T }): Promise<T | undefined> {
    this.paths.push(path);
    if (this.failing) throw this.failing;
    if (path === '/apis/core.openfeature.dev/v1beta1/namespaces/flagd/featureflags/flags') {
      if (!this.flagsThere) return undefined;
      const spec = this.revision === undefined ? { flagSpec: { flags: {} } } : flagsSpec({}, this.revision);
      return schema.parse({ metadata: { name: 'flags' }, spec });
    }
    if (path === '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website') {
      return schema.parse({ spec: { strategy: { canary: this.services } } });
    }
    const service = /^\/apis\/discovery\.k8s\.io\/v1\/namespaces\/website\/endpointslices\?labelSelector=(.+)$/.exec(
      path,
    )?.[1];
    if (service) {
      const name = decodeURIComponent(service).replace(/^kubernetes\.io\/service-name=/, '');
      return schema.parse({
        items: (this.slices[name] ?? []).map((slice) => ({
          addressType: slice.addressType ?? 'IPv4',
          ports: [{ name: 'http', port: slice.port ?? 8080, protocol: 'TCP' }],
          endpoints: slice.endpoints.map((e) => ({
            addresses: [e.ip],
            conditions: { ready: e.ready, serving: true, terminating: e.terminating ?? false },
            targetRef: { kind: 'Pod', name: e.name, namespace: 'website' },
          })),
        })),
      });
    }
    throw new Error(`The admin service may not read ${path}`);
  }

  text = async () => undefined;
  create = async () => {};
  remove = async () => {};
}

/** The app's pods' answers, by address: a revision, nothing (no header), or an error (no answer). */
class Pods {
  answers: Record<string, string | undefined | Error> = { '10.42.0.11': 'r3', '10.42.0.12': 'r3' };
  readonly asked: Pod[] = [];
  ask = async (pod: Pod) => {
    this.asked.push(pod);
    const answer = this.answers[pod.address];
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const log = pino({ level: 'silent' });

let clock = Date.parse('2026-10-26T09:00:00Z');
const minutes = (n: number) => {
  clock += n * 60_000;
};

const made = () => {
  const kube = new AppKube();
  const pods = new Pods();
  const held = new FlagsHeld({ kube, flags: FLAGS, rollout: ROLLOUT, log, ask: pods.ask, now: () => clock });
  return { kube, pods, held };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('whether the app holds the flags as set', () => {
  it('asks every ready pod behind both Services once, at its own address and port, and finds it holds them', async () => {
    const { kube, pods, held } = made();
    kube.slices.website?.[0]?.endpoints.push(
      { ip: '10.42.0.13', name: 'website-abc-3', ready: false },
      { ip: '10.42.0.14', name: 'website-abc-4', terminating: true },
      // Kubernetes says to read a ready condition it does not know as ready.
      { ip: '10.42.0.15', name: 'website-abc-5', ready: null },
    );
    kube.slices['website-canary']?.push({ addressType: 'FQDN', endpoints: [{ ip: 'example.com', name: 'x' }] });
    pods.answers['10.42.0.15'] = 'r3';
    await held.check();
    expect(pods.asked).toEqual([
      { address: '10.42.0.11', port: 8080, name: 'website-abc-1' },
      { address: '10.42.0.12', port: 8080, name: 'website-abc-2' },
      { address: '10.42.0.15', port: 8080, name: 'website-abc-5' },
    ]);
    // Read through the Roles alone: `flags` and the Rollout by name, and the slices of the Rollout's two Services.
    expect(kube.paths).toEqual([
      '/apis/core.openfeature.dev/v1beta1/namespaces/flagd/featureflags/flags',
      '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website',
      '/apis/discovery.k8s.io/v1/namespaces/website/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3Dwebsite',
      '/apis/discovery.k8s.io/v1/namespaces/website/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3Dwebsite-canary',
    ]);
    expect(held.figures()).toEqual({ differing: 0, narrowing: 0, checked: 1, set: 1 });
    expect(held.view()).toEqual({
      state: 'held',
      revision: 'r3',
      held: ['r3'],
      since: null,
      checkedAt: '2026-10-26T09:00:00.000Z',
    });
  });

  it('takes `none` from an app whose `flags` holds no flag set as holding them', async () => {
    const { kube, pods, held } = made();
    kube.revision = undefined;
    pods.answers = { '10.42.0.11': 'none', '10.42.0.12': 'none' };
    await held.check();
    expect(held.figures()).toEqual({ differing: 0, narrowing: 0, checked: 1, set: 0 });
    expect(held.view()).toMatchObject({ state: 'held', revision: null, held: ['none'] });
    // But not once `flags` holds one, nor `stale`, the app's word for flags it has lost.
    kube.revision = 'r1';
    pods.answers['10.42.0.12'] = 'stale';
    await held.check();
    expect(held.view()).toMatchObject({ state: 'taking', revision: 'r1', held: ['none', 'stale'] });
  });

  it('counts how long the app has differed from the first check that found it, through pods that come and go', async () => {
    const { kube, pods, held } = made();
    await held.check();
    const start = clock;
    pods.answers['10.42.0.12'] = 'r2';
    await held.check();
    expect(held.figures()?.differing).toBe(0);
    expect(held.view()).toMatchObject({ state: 'taking', since: new Date(start).toISOString(), held: ['r2', 'r3'] });
    minutes(1);
    // That pod is replaced, and another lags: the count goes on, as one figure for the app.
    kube.slices.website = [
      {
        endpoints: [
          { ip: '10.42.0.11', name: 'website-abc-1' },
          { ip: '10.42.0.16', name: 'b' },
        ],
      },
    ];
    pods.answers['10.42.0.11'] = 'r2';
    pods.answers['10.42.0.16'] = 'r3';
    await held.check();
    minutes(5);
    await held.check();
    expect(held.figures()).toMatchObject({ differing: 360, checked: 1 });
    expect(held.view()).toMatchObject({ state: 'lagging', since: new Date(start).toISOString() });
    // Every pod holds them again: back to 0.
    pods.answers['10.42.0.11'] = 'r3';
    await held.check();
    expect(held.figures()).toMatchObject({ differing: 0, checked: 1 });
    expect(held.view()).toMatchObject({ state: 'held', since: null });
  });

  it('counts on, and says it could not ask, when a pod does not answer or answers without the header', async () => {
    for (const answer of [new Error('connect ECONNREFUSED'), undefined]) {
      const { pods, held } = made();
      pods.answers['10.42.0.12'] = answer;
      await held.check();
      minutes(6);
      await held.check();
      expect(held.figures()).toMatchObject({ differing: 360, checked: 0, set: 1 });
      expect(held.view()).toMatchObject({ state: 'unchecked', held: ['r3'] });
    }
  });

  it('counts on when there is no pod to ask, no Rollout, no `flags`, or Kubernetes cannot be read', async () => {
    const cases: ((kube: AppKube) => void)[] = [
      (kube) => {
        kube.slices = {};
      },
      (kube) => {
        kube.services = {};
      },
      (kube) => {
        kube.flagsThere = false;
      },
      (kube) => {
        kube.failing = new Error('connect ECONNREFUSED');
      },
    ];
    for (const breaks of cases) {
      const { kube, held } = made();
      await held.check();
      breaks(kube);
      await held.check();
      minutes(6);
      await held.check();
      // Whether a flag set is held stays as last read.
      expect(held.figures()).toEqual({ differing: 360, narrowing: 0, checked: 0, set: 1 });
      expect(held.view().state).toBe('unchecked');
    }
  });

  it('counts a narrowing from its write until a check that began after it finds the app holding the flags', async () => {
    const { kube, pods, held } = made();
    await held.check();
    const written = clock;
    kube.revision = 'r4';
    held.written(true);
    expect(held.view()).toMatchObject({ state: 'taking', since: new Date(written).toISOString() });
    minutes(1);
    await held.check();
    minutes(0.5);
    expect(held.figures()).toMatchObject({ differing: 90, narrowing: 90 });
    expect(held.view()).toMatchObject({ state: 'lagging', revision: 'r4', held: ['r3'] });
    // A check that began before another write cannot say the app took that one.
    pods.answers = { '10.42.0.11': 'r4', '10.42.0.12': 'r4' };
    const racing = held.check();
    held.written(false);
    await racing;
    expect(held.figures()).toMatchObject({ narrowing: 90 });
    await held.check();
    expect(held.figures()).toEqual({ differing: 0, narrowing: 0, checked: 1, set: 1 });
  });

  it('starts no narrowing’s count for a widening', async () => {
    const { kube, held } = made();
    await held.check();
    kube.revision = 'r4';
    held.written(false);
    minutes(2);
    await held.check();
    expect(held.figures()).toMatchObject({ differing: 120, narrowing: 0 });
  });

  it('tells anyone no pod’s address or name', async () => {
    const { pods, held } = made();
    pods.answers['10.42.0.12'] = 'r2';
    await held.check();
    const view = JSON.stringify(held.view());
    expect(view).not.toMatch(/10\.42|website-abc/);
    expect(new FlagsHeld({ kube: new AppKube(), flags: FLAGS, rollout: ROLLOUT, log }).view()).toEqual({
      state: 'unchecked',
      revision: null,
      held: [],
      since: null,
      checkedAt: null,
    });
    expect(new FlagsHeld({ kube: new AppKube(), flags: FLAGS, rollout: ROLLOUT, log }).figures()).toBeUndefined();
  });

  it('asks at once, then every minute, and every ten seconds for two minutes after a write', async () => {
    vi.useFakeTimers();
    const { kube, pods, held } = made();
    const checks = () => kube.paths.filter((p) => p.includes('featureflags')).length;
    held.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks()).toBe(1);
    await vi.advanceTimersByTimeAsync(HELD.everyMs);
    expect(checks()).toBe(2);
    // A write the app does not take: asked again soon, and again.
    kube.revision = 'r4';
    held.written(true);
    await vi.advanceTimersByTimeAsync(HELD.soonMs / 2);
    expect(checks()).toBe(3);
    clock += HELD.soonMs / 2;
    await vi.advanceTimersByTimeAsync(HELD.soonMs);
    expect(checks()).toBe(4);
    // Past the two minutes, back to every minute.
    clock += HELD.afterWriteMs;
    await vi.advanceTimersByTimeAsync(HELD.soonMs);
    expect(checks()).toBe(5);
    await vi.advanceTimersByTimeAsync(HELD.soonMs);
    expect(checks()).toBe(5);
    // Once the app takes a write, every minute again at once.
    pods.answers = { '10.42.0.11': 'r4', '10.42.0.12': 'r4' };
    kube.revision = 'r5';
    held.written(false);
    await vi.advanceTimersByTimeAsync(HELD.soonMs / 2);
    expect(checks()).toBe(6);
    kube.revision = 'r4';
    await vi.advanceTimersByTimeAsync(HELD.soonMs);
    expect(checks()).toBe(7);
    expect(held.figures()?.differing).toBe(0);
    await vi.advanceTimersByTimeAsync(HELD.soonMs * 2);
    expect(checks()).toBe(7);
    await held.stop();
    await vi.advanceTimersByTimeAsync(HELD.everyMs * 2);
    expect(checks()).toBe(7);
  });
});

describe('asking a pod', () => {
  it('asks for /health with the mark, at the address given, and reads the revision header alone', async () => {
    const seen: { url: string | undefined; mark: string | string[] | undefined; method: string | undefined }[] = [];
    let revision: string | undefined = 'r7';
    const server = createServer((req, res) => {
      seen.push({ url: req.url, mark: req.headers['x-unmeasured'], method: req.method });
      if (revision) res.setHeader('x-flags-revision', revision);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const pod = { address: '127.0.0.1', port, name: 'website-abc-1' };
      expect(await askPod(pod, AbortSignal.timeout(2_000))).toBe('r7');
      revision = undefined;
      expect(await askPod(pod, AbortSignal.timeout(2_000))).toBeUndefined();
      expect(seen).toEqual([
        { url: '/health', mark: '1', method: 'GET' },
        { url: '/health', mark: '1', method: 'GET' },
      ]);
    } finally {
      server.close();
    }
  });
});
