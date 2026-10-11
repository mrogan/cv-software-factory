import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { Prometheus } from '../../src/clients/prometheus.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import type { AnalysisRun, Rollout } from '../../src/release/read.ts';
import type { Kube } from '../../src/runners/kube.ts';
import { quiet } from '../github/fake.ts';
import { CANARY, commitOf, digestOf, rollout, run, STABLE } from '../release/fixtures.ts';
import { FakeGitHub, FakeProbes, FakeSteps } from './fakes.ts';

let database: Database;
let events: EventWriter;
beforeEach(async () => {
  database = await freshDatabase('release');
  events = new EventWriter(database.writer, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
});
afterEach(() => database?.end());

let now = Date.parse('2026-10-11T09:00:00Z');

const event = <K extends NewEvent['type']>(
  workItem: string,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'],
) =>
  ({
    id: crypto.randomUUID(),
    ts: new Date(now).toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor,
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

/**
 * A work item whose fix merged in pull request `number`, as `commit`, and which the line holds at Release. Its ticket
 * came from a probe, which the line here has no way to ask at Verify: there it waits.
 */
async function merged(number: number, commit: string, sense: 'probe' | 'report' = 'probe'): Promise<string> {
  const workItem = await nextWorkItem(database.writer);
  await events.append([
    event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'A redirect loop', sample: false }, 'triage'),
    event(
      workItem,
      'ticket.opened',
      {
        title: 'A redirect loop on /departments/:department',
        category: 'errors',
        severity: 'broken',
        fingerprint: { route: '/departments/:department', class: 'redirect-loop' },
        traces: [],
      },
      'triage',
    ),
    event(
      workItem,
      'signal.received',
      { sense, check: 'departments', route: '/departments/:department', version: commitOf(STABLE) },
      sense === 'probe' ? 'probe' : 'widget',
    ),
    event(workItem, 'pull-request.merged', { number, commit, by: 'martin' }, 'martin'),
  ]);
  await database.writer`insert into line (work_item, stage, issue) values (${workItem}, 'release', ${number - 1})`;
  return workItem;
}

/** The Kubernetes API, holding the app's Rollout and its runs, and counting what is asked of it. */
class FakeKube implements Kube {
  rollout: Rollout | undefined;
  runs: AnalysisRun[] = [];
  readonly asked: string[] = [];

  async get<T>(path: string, schema: z.ZodType<T>): Promise<T | undefined> {
    this.asked.push(path);
    if (path === '/apis/argoproj.io/v1alpha1/namespaces/website/rollouts/website') {
      return this.rollout && schema.parse(this.rollout);
    }
    if (path === '/apis/argoproj.io/v1alpha1/namespaces/website/analysisruns') {
      return schema.parse({ items: this.runs });
    }
    throw new Error(`The line may not read ${path}`);
  }

  async create(): Promise<void> {
    throw new Error('The release watch changes nothing');
  }

  async remove(): Promise<void> {
    throw new Error('The release watch changes nothing');
  }
}

/**
 * Prometheus, answering each version's figures by its hash: the canary a little slower, with a few more errors. A
 * range is the same figure at every step.
 */
function prometheus(asked: string[] = [], failing = false) {
  const figure = (query: string) => {
    const canary = query.includes(CANARY);
    if (query.includes('histogram_quantile')) return canary ? 0.124 : 0.118;
    if (query.includes('5..')) return canary ? 0.004 : 0.002;
    return canary ? 224.4 : 640;
  };
  return new Prometheus('http://prometheus.test', async (input) => {
    const url = new URL(String(input));
    const query = url.searchParams.get('query') ?? '';
    asked.push(url.pathname);
    if (failing) return new Response('down', { status: 503 });
    if (url.pathname === '/api/v1/query') {
      return Response.json({ data: { result: [{ metric: {}, value: [0, String(figure(query))] }] } });
    }
    const start = Number(url.searchParams.get('start'));
    const end = Number(url.searchParams.get('end'));
    const step = Number(url.searchParams.get('step'));
    const values: [number, string][] = [];
    for (let at = start; at <= end; at += step) values.push([at, String(figure(query))]);
    return Response.json({ data: { result: [{ metric: {}, values }] } });
  });
}

function line(options: Partial<LineOptions> = {}, { prometheusDown = false } = {}) {
  const github = new FakeGitHub();
  const kube = new FakeKube();
  const asked: string[] = [];
  const it = new Line({
    sql: database.writer,
    events,
    steps: new FakeSteps(database.writer, {}),
    github,
    log: quiet,
    me: 'test',
    now: () => new Date(now),
    gatesEveryMs: 60_000,
    deployEveryMs: 60_000,
    releaseEveryMs: 0,
    release: {
      kube,
      rollout: { namespace: 'website', name: 'website' },
      prometheus: prometheus(asked, prometheusDown),
    },
    ...options,
  });
  return { line: it, github, kube, asked };
}

const typesOf = async (workItem: string | null) =>
  (
    await database.writer<{ type: string; actor: string }[]>`
      select type, actor from events
      where work_item is not distinct from ${workItem}
        and type in ('release.started', 'canary.stepped', 'release.promoted', 'release.rolled-back')
      order by seq`
  ).map((r) => `${r.type} by ${r.actor}`);

const payloads = async <K extends NewEvent['type']>(workItem: string | null, type: K) =>
  (
    await database.writer<{ payload: PayloadOf<K> }[]>`
      select payload from events where work_item is not distinct from ${workItem} and type = ${type} order by seq`
  ).map((r) => r.payload);

const stage = async (workItem: string) =>
  (await database.writer<{ stage: string }[]>`select stage from line where work_item = ${workItem}`)[0]?.stage;

/** The app's main: the commits of two fixes, the stable version's, a later fix's, and a release's. */
const [FIX_1, FIX_2, FIX_3, FIX_4] = ['1', '2', '3', '4'].map((c) => c.repeat(40)) as [string, string, string, string];
const HISTORY = ['0'.repeat(40), FIX_1, FIX_2, commitOf(STABLE), FIX_3, FIX_4, commitOf(CANARY)];

describe('the line’s watch of the app’s release', () => {
  it('records the fixes already live as found, and sends them on to Verify (work items 1001 and 1006)', async () => {
    const first = await merged(17, FIX_1);
    const second = await merged(25, FIX_2);
    const later = await merged(30, FIX_3);
    // A dry run's merge, which GitHub never had, is never found live.
    const dryRun = await merged(1_000_000_001, 'd'.repeat(40));
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();

    for (const workItem of [first, second]) {
      expect(await typesOf(workItem)).toEqual(['release.started by factory', 'release.promoted by factory']);
      expect(await stage(workItem)).toBe('verify');
    }
    expect(await payloads(first, 'release.started')).toEqual([
      {
        release: STABLE,
        version: commitOf(STABLE),
        previous: commitOf(STABLE),
        commit: commitOf(STABLE),
        image: { digest: digestOf(STABLE), signed: true, admitted: true },
        watched: false,
        dryRun: false,
      },
    ]);
    // Not in the stable version yet: held at Release for the deploy that will carry it.
    expect(await typesOf(later)).toEqual([]);
    expect(await stage(later)).toBe('held');
    expect(await typesOf(dryRun)).toEqual([]);

    // Read again, nothing more.
    await it.tick();
    expect(await typesOf(first)).toHaveLength(2);
  });

  it('records a release on each work item it carries, step by step, and its promotion; a new line adds nothing', async () => {
    const shipped = await merged(17, FIX_1);
    const carried = [await merged(30, FIX_3), await merged(31, FIX_4)];
    const { line: it, github, kube, asked } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    expect(await typesOf(shipped)).toHaveLength(2);

    // A deploy merged: the canary starts, and its first step's analysis ends.
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    kube.runs = [
      run({ created: t0, phase: 'Running' }),
      run({ step: 2, created: t0, completed: new Date(now + 3.5 * 60_000).toISOString() }),
    ];
    await it.tick();
    for (const workItem of carried) {
      expect(await typesOf(workItem)).toEqual(['release.started by rollouts', 'canary.stepped by rollouts']);
      expect(await stage(workItem)).toBe('release');
    }
    expect(await typesOf(shipped)).toHaveLength(2);
    const [stepped] = await payloads(carried[0] as string, 'canary.stepped');
    expect(stepped?.figures).toEqual({
      canary: { requests: 224, errorRate: 0.004, p99Ms: 124, journeys: null },
      baseline: { requests: 640, errorRate: 0.002, p99Ms: 118, journeys: null },
    });
    expect(stepped?.weight).toBe(25);
    expect(asked.filter((path) => path === '/api/v1/query')).toHaveLength(6);

    // Promoted. The line starts again, and appends nothing it has.
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    const again = line();
    again.github.history = HISTORY;
    again.kube.rollout = kube.rollout;
    again.kube.runs = kube.runs;
    await again.line.tick();
    for (const workItem of carried) {
      expect(await typesOf(workItem)).toEqual([
        'release.started by rollouts',
        'canary.stepped by rollouts',
        'release.promoted by rollouts',
      ]);
      expect(await stage(workItem)).toBe('verify');
    }
  });

  it('carries a work item by its latest merge, and leaves one closed while its release runs', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const [carried, closing, mergedAgain] = [await merged(30, FIX_3), await merged(31, FIX_4), await merged(32, FIX_4)];
    // Sent back after its merge, the third merged again, as a commit this release does not run.
    await events.append([
      event(mergedAgain, 'pull-request.merged', { number: 33, commit: 'e'.repeat(40), by: 'martin' }, 'martin'),
    ]);
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' })];
    await it.tick();
    expect(await typesOf(carried)).toEqual(['release.started by rollouts']);
    expect(await typesOf(closing)).toEqual(['release.started by rollouts']);
    expect(await typesOf(mergedAgain)).toEqual([]);
    // Martin closes one at Release: the release goes on for the other.
    await events.append([
      event(closing, 'work-item.closed', { outcome: 'no-change', reason: 'Martin closed it' }, 'martin'),
    ]);
    kube.runs = [...kube.runs, run({ step: 2, created: t0, completed: t0 })];
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    await it.tick();
    expect(await typesOf(carried)).toEqual(['release.started by rollouts', 'canary.stepped by rollouts']);
    expect(await typesOf(closing)).toEqual(['release.started by rollouts']);
  });

  it('records a release that carries none of the line’s work on the line', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    expect(await typesOf(null)).toEqual([
      'release.started by factory',
      'release.promoted by factory',
      'release.started by rollouts',
      'release.promoted by rollouts',
    ]);
  });

  it('records a rollback with the series that condemned it, and holds the work it carried at Release again', async () => {
    const { line: it, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const carried = await merged(30, FIX_3);
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' })];
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, abort: true });
    kube.runs = [
      run({
        created: t0,
        completed: new Date(now + 3 * 60_000).toISOString(),
        phase: 'Failed',
        message: 'Metric "latency" assessed Failed due to failed (2) > failureLimit (1)',
        metrics: { latency: { phase: 'Failed', value: '[0.247]' } },
      }),
    ];
    await it.tick();
    const [rolledBack] = await payloads(carried, 'release.rolled-back');
    expect(rolledBack).toMatchObject({ release: CANARY, weight: 25, restored: commitOf(STABLE) });
    expect(rolledBack?.failed).toEqual([
      {
        name: 'latency',
        phase: 'failed',
        value: 0.247,
        limit: 0,
        series: expect.objectContaining({ label: 'p99 latency', unit: 'ms', stepSeconds: 15, at: 12 }),
      },
    ]);
    expect(rolledBack?.failed[0]?.series?.canary.slice(0, 2)).toEqual([124, 124]);
    expect(await stage(carried)).toBe('held');
  });

  it('records a step without its figures when Prometheus cannot say', async () => {
    const { line: it, github, kube } = line({}, { prometheusDown: true });
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    const carried = await merged(30, FIX_3);
    const t0 = new Date(now).toISOString();
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 3, weight: 25 });
    kube.runs = [run({ created: t0, phase: 'Running' }), run({ step: 2, created: t0, completed: t0 })];
    await it.tick();
    const [stepped] = await payloads(carried, 'canary.stepped');
    expect(stepped?.analysis.measures.map((m) => m.name)).toEqual(['enough-requests', 'errors', 'latency', 'journeys']);
    expect(stepped?.figures).toBeUndefined();
  });

  it('records a release of the one work item the line acts on, and the line’s own, while it acts on that alone', async () => {
    const workItem = await merged(30, FIX_3);
    const { line: it, github, kube } = line({ only: workItem });
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    // The version found live carries none of the line's work: recorded on the line, as what the next is compared with.
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await it.tick();
    expect(await typesOf(null)).toEqual(['release.started by factory', 'release.promoted by factory']);
    kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await it.tick();
    kube.rollout = rollout({ current: CANARY, stable: CANARY });
    await it.tick();
    expect(await typesOf(workItem)).toEqual(['release.started by rollouts', 'release.promoted by rollouts']);
    expect(await stage(workItem)).toBe('verify');
  });

  it('leaves a release that carries another work item for the whole line, while it acts on one alone', async () => {
    const { line: whole, github, kube } = line();
    github.history = HISTORY;
    github.revisions.set(digestOf(STABLE), commitOf(STABLE));
    github.revisions.set(digestOf(CANARY), commitOf(CANARY));
    kube.rollout = rollout({ current: STABLE, stable: STABLE });
    await whole.tick();
    const [workItem, other] = [await merged(30, FIX_3), await merged(31, FIX_4)];
    const only = line({ only: workItem });
    only.github.history = HISTORY;
    for (const [digest, commit] of github.revisions) only.github.revisions.set(digest, commit);
    only.kube.rollout = rollout({ current: CANARY, stable: STABLE, stepIndex: 1, weight: 25 });
    await only.line.tick();
    expect(await typesOf(workItem)).toEqual([]);
    expect(await typesOf(other)).toEqual([]);
    expect(await typesOf(null)).toHaveLength(2);

    // The line acts on them all again, and records it on both.
    kube.rollout = only.kube.rollout;
    await whole.tick();
    for (const carried of [workItem, other]) expect(await typesOf(carried)).toEqual(['release.started by rollouts']);
  });
});

describe('a dry run’s release', () => {
  it('releases each merge the dry run made by its word, a while after the merge, and sends it on to Verify', async () => {
    const workItem = await merged(1_000_000_001, 'd'.repeat(40));
    const real = await merged(30, FIX_3);
    const { line: it, github } = line({ release: null, dryRun: true, dryRunReleaseMs: 60_000 });
    github.history = HISTORY;
    await it.tick();
    expect(await typesOf(workItem)).toEqual([]);
    for (let minute = 1; minute <= 4; minute++) {
      now += 60_000;
      await it.tick();
    }
    expect(await typesOf(workItem)).toEqual([
      'release.started by factory',
      'canary.stepped by factory',
      'canary.stepped by factory',
      'release.promoted by factory',
    ]);
    expect((await payloads(workItem, 'release.started'))[0]).toMatchObject({
      dryRun: true,
      release: 'dry-run-dddddddddddd',
    });
    expect(await stage(workItem)).toBe('verify');
    // A real merge waits for a real release.
    expect(await typesOf(real)).toEqual([]);
  });

  it('is not answered for outside a dry run', async () => {
    const workItem = await merged(1_000_000_001, 'd'.repeat(40));
    const { line: it } = line({ release: null });
    now += 10 * 60_000;
    await it.tick();
    expect(await typesOf(workItem)).toEqual([]);
  });
});

describe('Verify on the line', () => {
  /** A release of `commit` carrying the work item, promoted. */
  async function promote(workItem: string, release = 'f00dfeed01', version = commitOf(CANARY), dryRun = false) {
    const payload = { release, version, previous: commitOf(STABLE), commit: version, watched: !dryRun, dryRun };
    await events.append([
      event(workItem, 'release.started', { ...payload, ...(dryRun ? {} : { image: IMAGE }) }, 'rollouts'),
      event(workItem, 'release.promoted', payload, 'rollouts'),
    ]);
  }
  const IMAGE = { digest: digestOf(CANARY), signed: true, admitted: true };
  const pass = async (it: Line) => {
    await it.tick();
    await it.idle();
  };
  const types = async (workItem: string) =>
    (
      await database.writer<{ type: string }[]>`
        select type from events where work_item = ${workItem} and type not like 'release.%' order by seq`
    ).map((r) => r.type);

  it('sends the work back to Plan when the probe still fails, with a session of its own, and holds the second time', async () => {
    const workItem = await merged(30, FIX_3);
    await database.writer`update line set session = 'session-1' where work_item = ${workItem}`;
    await promote(workItem);
    const probes = new FakeProbes({ outcome: 'persists', version: commitOf(CANARY), runs: ['failed', 'failed'] });
    const { line: it, github } = line({ release: null, verify: { probes } });
    await pass(it); // Verify looks: it persists
    await pass(it); // and the work goes back to Plan
    expect((await types(workItem)).slice(-2)).toEqual(['verification.finished', 'work.returned']);
    expect((await payloads(workItem, 'work.returned'))[0]).toEqual({
      from: 'verify',
      to: 'plan',
      reason: `The probe still saw “departments” on ${commitOf(CANARY)}, the release that carried the fix`,
    });
    const [row] = await database.writer<{ stage: string; session: string | null }[]>`
      select stage, session from line where work_item = ${workItem}`;
    expect(row?.session).toBeNull();
    // The issue stays open.
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);

    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);
  });

  it('holds for Martin when a second fix’s release leaves the signal persisting, and keeps the issue open', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const persisted = {
      outcome: 'persists' as const,
      sense: 'probe' as const,
      check: 'departments',
      version: commitOf(CANARY),
      against: commitOf(STABLE),
      pages: [],
      dryRun: false,
    };
    // The first fix's pass, sent back from Verify; the second fix merged and released.
    await events.append([
      event(workItem, 'verification.finished', persisted, 'probe'),
      event(workItem, 'work.returned', { from: 'verify', to: 'plan', reason: 'It persists' }, 'factory'),
      event(workItem, 'pull-request.merged', { number: 31, commit: FIX_4, by: 'martin' }, 'martin'),
    ]);
    await promote(workItem, 'f00dfeed02');
    const probes = new FakeProbes({ outcome: 'persists', version: commitOf(CANARY), runs: ['failed', 'failed'] });
    const { line: it, github } = line({ release: null, verify: { probes } });
    await pass(it);
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      stage: 'verify',
      kind: 'held',
      cause: 'verify',
    });
    expect(await stage(workItem)).toBe('held');
    expect(github.acts.filter((a) => a.action === 'closeIssue')).toEqual([]);
  });

  it('drops what a sense saw when a release promoted while it looked, and looks again at the new one', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const later = 'e'.repeat(40);
    const asked: string[] = [];
    const probes = {
      verify: async () => {
        asked.push('verify');
        if (asked.length === 1) {
          // Meanwhile, another release goes out, on the line.
          await events.append([
            event(
              null as unknown as string,
              'release.promoted',
              {
                release: 'f00dfeed09',
                version: later,
                previous: commitOf(CANARY),
                commit: later,
                watched: true,
                dryRun: false,
              },
              'rollouts',
            ),
          ]);
          return {
            outcome: 'cleared' as const,
            version: commitOf(CANARY),
            runs: ['passed' as const, 'passed' as const],
          };
        }
        return { outcome: 'cleared' as const, version: later, runs: ['passed' as const, 'passed' as const] };
      },
    };
    const { line: it } = line({ release: null, verify: { probes } });
    await pass(it);
    expect(await types(workItem)).not.toContain('verification.finished');
    await pass(it);
    expect(await payloads(workItem, 'verification.finished')).toEqual([
      expect.objectContaining({ outcome: 'cleared', version: later }),
    ]);
  });

  it('holds for Martin when only a visitor’s report saw the defect, and closes it as verified on his approval', async () => {
    const workItem = await merged(30, FIX_3, 'report');
    await promote(workItem);
    const { line: it, github } = line({ release: null });
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      stage: 'verify',
      kind: 'approval',
      cause: 'verify',
    });
    await events.append([
      event(workItem, 'hold.answered', { decision: 'approved', answer: 'The page is right now' }, 'martin'),
    ]);
    await pass(it);
    expect(github.acts.at(-1)).toEqual({
      action: 'closeIssue',
      args: {
        number: 29,
        reason: 'completed',
        comment: expect.stringContaining('Martin judged it cleared, saying: The page is right now.'),
      },
    });
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      { outcome: 'verified', reason: 'Martin judged it cleared, saying: The page is right now' },
    ]);
  });

  it('looks again later when the sense cannot tell, never closes on it, and asks Martin after a day', async () => {
    const workItem = await merged(30, FIX_3);
    await promote(workItem);
    const probes = new FakeProbes(new Error('The probes did not answer'));
    const { line: it } = line({ release: null, verify: { probes }, verifyEveryMs: 5 * 60_000 });
    await pass(it);
    await pass(it);
    expect(probes.asked).toHaveLength(1);
    expect(await stage(workItem)).toBe('verify');
    now += 5 * 60_000;
    probes.answers.splice(0, 1, { outcome: 'unsure', version: commitOf(CANARY), runs: ['passed', 'unsure'] });
    await pass(it);
    expect(probes.asked).toHaveLength(2);
    expect(await types(workItem)).not.toContain('verification.finished');

    // A day after the release, it still cannot tell: Martin is asked, told why.
    now += 24 * 60 * 60_000;
    await pass(it);
    expect((await payloads(workItem, 'hold.started')).at(-1)).toMatchObject({
      stage: 'verify',
      kind: 'held',
      cause: 'verify',
      reason: expect.stringContaining('Verify could not tell in 24 hours after the release'),
    });
  });

  it('verifies a dry run’s work item by the dry run’s word, and closes it, only in a dry run; outside one it holds', async () => {
    // A line no longer in a dry run has nothing to verify it by: Martin judges.
    const left = await merged(1_000_000_002, 'e'.repeat(40));
    await promote(left, 'dry-run-eeeeeeeeeeee', 'e'.repeat(40), true);
    const live = line({ release: null });
    await pass(live.line);
    expect(await types(left)).not.toContain('verification.finished');
    expect((await payloads(left, 'hold.started')).at(-1)).toMatchObject({ stage: 'verify', cause: 'verify' });

    const workItem = await merged(1_000_000_001, 'd'.repeat(40));
    await promote(workItem, 'dry-run-dddddddddddd', 'd'.repeat(40), true);

    const { line: it, github } = line({ release: null, dryRun: true });
    await pass(it);
    await pass(it);
    expect(await payloads(workItem, 'verification.finished')).toEqual([
      expect.objectContaining({ outcome: 'cleared', sense: 'probe', dryRun: true }),
    ]);
    expect(github.acts.at(-1)).toMatchObject({ action: 'closeIssue', args: { reason: 'completed' } });
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      { outcome: 'verified', reason: 'The dry run’s word: its release never shipped, so no sense looked' },
    ]);
    expect(await stage(workItem)).toBe('ended');
  });
});
