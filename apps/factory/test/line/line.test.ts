import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import type { Handback } from '../../../runner/src/step.ts';
import { Line } from '../../src/line/worker.ts';
import { quiet } from '../github/fake.ts';
import { type Agent, FakeGitHub, FakeSteps, MAIN } from './fakes.ts';

let database: Database;
let events: EventWriter;
beforeEach(async () => {
  database = await freshDatabase('line');
  events = new EventWriter(database.writer, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
});
afterEach(() => database?.end());

const event = <K extends NewEvent['type']>(
  workItem: string | null,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'] = 'factory',
): NewEvent =>
  ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    work_item: workItem,
    type,
    version: VERSIONS[type],
    actor,
    summary: `${type} for the test`,
    payload,
    artifacts: [],
  }) as NewEvent;

/** A ticket as triage opens one, with its severity. */
async function ticket(severity: PayloadOf<'ticket.opened'>['severity'] = 'broken', route = '/search'): Promise<string> {
  const workItem = await nextWorkItem(database.writer);
  await events.append([
    event(workItem, 'work-item.opened', { kind: 'defect-fix', title: 'Server errors', sample: false }, 'triage'),
    event(
      workItem,
      'ticket.opened',
      {
        title: `Server errors on ${route}`,
        category: 'errors',
        severity,
        fingerprint: { route, class: 'server-error' },
        traces: [],
      },
      'triage',
    ),
  ]);
  return workItem;
}

const handback = (result: unknown, patch = ''): Handback => ({
  ending: 'finished',
  patch,
  note: 'Escaped the query before it reaches the database.',
  turns: 6,
  session: 'session-1',
  result,
});

const PATCH = `diff --git a/src/search.ts b/src/search.ts
--- a/src/search.ts
+++ b/src/search.ts
@@ -1 +1 @@
-old
+new
diff --git a/test/search.test.ts b/test/search.test.ts
new file mode 100644
--- /dev/null
+++ b/test/search.test.ts
@@ -0,0 +1,2 @@
+it('finds a quote', () => {});
+expect(1).toBe(1);
`;

const SPEC = {
  outcome: 'Search answers a query with a quote in it.',
  criteria: [{ given: 'a query with a quote', when: 'it is searched', expect: 'the page lists matches' }],
  scope: ['src/search.ts', 'test/'],
  risks: [],
  rollout: 'Ships as it is.',
};

const AGENTS: Record<string, Agent> = {
  planner: () => handback({ verdict: 'spec', spec: SPEC }),
  coder: () => handback({ title: 'fix(search): escape the query' }, PATCH),
  reviewer: () => handback({ verdict: 'approved', note: 'It does what the spec says.', findings: [] }),
  describer: () =>
    handback({
      title: 'fix(search): escape the query',
      body: 'Search escaped nothing, so a quote broke the query.',
      summary: { title: 'Search with a quote', description: 'Fixed.', story: 'The factory fixed search.' },
    }),
};

function line(agents: Partial<Record<string, Agent>> = AGENTS) {
  const steps = new FakeSteps(database.writer, agents);
  const github = new FakeGitHub();
  const it = new Line({ sql: database.writer, events, steps, github, log: quiet, gatesEveryMs: 0, me: 'test' });
  /** A pass of the line, and whatever steps it started, to their end. */
  const pass = async () => {
    await it.tick();
    await it.idle();
  };
  return { line: it, steps, github, pass };
}

async function types(workItem: string): Promise<string[]> {
  const rows = await database.writer<{ type: string }[]>`
    select type from events where work_item = ${workItem} order by seq`;
  return rows.map((r) => r.type);
}

async function payloads<K extends NewEvent['type']>(workItem: string, type: K): Promise<PayloadOf<K>[]> {
  const rows = await database.writer<{ payload: PayloadOf<K> }[]>`
    select payload from events where work_item = ${workItem} and type = ${type} order by seq`;
  return rows.map((r) => r.payload);
}

const stage = async (workItem: string) =>
  (await database.writer<{ stage: string }[]>`select stage from line where work_item = ${workItem}`)[0]?.stage;

describe('the line', () => {
  it('carries a ticket through plan, build, gates, review and description to Martin’s merge', async () => {
    const workItem = await ticket();
    const { pass, steps, github } = line();

    await pass(); // the issue, and the planner
    expect(github.acts[0]).toMatchObject({ action: 'openIssue', args: { title: 'Server errors on /search' } });
    expect(String(github.acts[0]?.args.body)).toContain('`server-error` on `/search`');
    expect(steps.requests[0]).toMatchObject({
      workItem,
      agent: 'planner',
      round: 1,
      attempt: 1,
      commit: MAIN,
      result: true,
      repository: 'https://github.com/mrogan/cv-worlds-worst-website.git',
    });
    expect(steps.requests[0]?.prompt).toContain('Category errors, severity broken');

    await pass(); // the coder
    expect(github.acts.map((a) => a.action).slice(1)).toEqual(['setBranch', 'applyPatch', 'openPullRequest']);
    expect(github.acts[1]?.args).toEqual({
      branch: `factory/${workItem}-server-errors-on-search`,
      sha: MAIN,
      force: true,
    });
    expect(github.acts[3]?.args).toMatchObject({ draft: true, base: 'main' });
    expect(String(github.acts[3]?.args.body)).toContain('Refers to #41.');
    expect(await stage(workItem)).toBe('gates');

    await pass(); // nothing has run on the pull request yet
    expect(steps.requests).toHaveLength(2);
    github.pass();
    await pass(); // the gates pass, and the reviewer
    await pass(); // the describer
    await pass(); // the hold for Martin
    expect(await stage(workItem)).toBe('held');
    expect(github.acts.map((a) => a.action).slice(4)).toEqual(['review', 'updatePullRequest', 'readyForReview']);
    // The reviewer starts from the pull request's head, and takes its diff against the pull request's base.
    const head = github.pulls.get(12)?.head.sha;
    expect(steps.requests[2]).toMatchObject({ agent: 'reviewer', commit: head });
    expect(steps.requests[2]?.prompt).toContain(`the diff from ${MAIN} to the checkout's head`);

    github.merge();
    await pass();
    expect(steps.finished).toEqual([workItem]);
    expect(await stage(workItem)).toBe('ended');
    expect(await types(workItem)).toEqual([
      'work-item.opened',
      'ticket.opened',
      'model.called',
      'spec.written',
      'model.called',
      'pull-request.pushed',
      'gates.started',
      'gate.finished',
      'gates.finished',
      'model.called',
      'review.submitted',
      'model.called',
      'work-item.summarised',
      'hold.started',
      'pull-request.merged',
    ]);
    expect((await payloads(workItem, 'pull-request.pushed'))[0]).toEqual({
      number: 12,
      title: 'fix(search): escape the query',
      branch: `factory/${workItem}-server-errors-on-search`,
      attempt: 1,
      testsFirst: true,
      files: [
        { path: 'src/search.ts', added: 1, removed: 1 },
        { path: 'test/search.test.ts', added: 2, removed: 0 },
      ],
    });
    // Each step's calls, summed from the gateway's audit log: the refused one is not among them.
    expect((await payloads(workItem, 'model.called'))[0]).toEqual({
      agent: 'planner',
      provider: 'local',
      model: 'qwen/qwen3.8-27b',
      settings: { maxTurns: 30 },
      tokens: { input: 200, output: 40, cacheRead: 100, cacheWrite: 20 },
      costUsd: 0.03,
      durationMs: 2000,
      calls: 2,
    });
    expect((await payloads(workItem, 'hold.started'))[0]).toMatchObject({ stage: 'review', kind: 'approval' });
    // Nothing more to do: the next pass starts nothing.
    await pass();
    expect(steps.requests.map((r) => r.agent)).toEqual(['planner', 'coder', 'reviewer', 'describer']);
  });

  it('sends a failing change back to the coder, which resumes its session on a branch that moved on', async () => {
    const workItem = await ticket();
    const { pass, steps, github } = line();
    await pass();
    await pass();
    github.pass(12, 'failure');
    const head = github.pulls.get(12)?.head.sha;
    await pass(); // the gates fail, the work goes back, and the coder's second round starts from the pull request's head
    expect(steps.requests.at(-1)).toMatchObject({
      agent: 'coder',
      round: 2,
      attempt: 3,
      resume: 'session-1',
      commit: head,
    });
    expect(head).not.toBe(MAIN);
    expect(github.acts.filter((a) => a.action === 'openPullRequest')).toHaveLength(1);
    expect((await payloads(workItem, 'work.returned'))[0]).toEqual({
      from: 'gates',
      to: 'build',
      reason: 'The gates failed: test',
    });
    expect((await payloads(workItem, 'pull-request.pushed')).map((p) => p.attempt)).toEqual([1, 2]);
  });

  it('takes the oldest ticket of the highest severity, and one at a time', async () => {
    const cosmetic = await ticket('cosmetic', '/');
    const broken = await ticket('broken', '/search');
    const alsoBroken = await ticket('broken', '/products');
    const { pass, steps } = line({ ...AGENTS, coder: () => 'works on' });
    await pass(); // the broken ticket, planned
    expect(steps.requests.map((r) => r.workItem)).toEqual([broken]);
    expect(await stage(alsoBroken)).toBeUndefined();
    const working = line({ ...AGENTS, coder: () => 'works on' });
    await working.line.tick(); // the coder is working on it: nothing else comes on
    expect(await stage(alsoBroken)).toBeUndefined();
    expect(await stage(cosmetic)).toBeUndefined();
    await working.steps.cancel();
    await working.line.idle();
  });

  it('runs a failed step again as a new job, and holds the work item when it keeps failing', async () => {
    const workItem = await ticket();
    const { pass, steps } = line({ ...AGENTS, planner: () => handback({ verdict: 'maybe' }) });
    await pass();
    await pass();
    expect(steps.requests.map((r) => r.attempt)).toEqual([1, 2]);
    await pass();
    expect(steps.requests).toHaveLength(2);
    expect(await types(workItem)).toEqual([
      'work-item.opened',
      'ticket.opened',
      'model.called',
      'model.called',
      'hold.started',
    ]);
    const [hold] = await payloads(workItem, 'hold.started');
    expect(hold).toMatchObject({ stage: 'plan', kind: 'held' });
    expect(hold?.reason).toMatch(/^The planner failed 2 times: The planner's result does not fit its schema/);
  });

  it('holds a patch outside the spec’s scope, and never sends it to GitHub', async () => {
    const workItem = await ticket();
    const outside = PATCH.replaceAll('src/search.ts', 'src/server.ts');
    const { pass, github } = line({ ...AGENTS, coder: () => handback({ title: 'fix(search): escape it' }, outside) });
    await pass();
    await pass();
    expect(github.acts.map((a) => a.action)).toEqual(['openIssue']);
    expect((await payloads(workItem, 'hold.started'))[0]?.reason).toBe(
      'The coder changed files outside the spec’s scope: src/server.ts',
    );
  });

  it('reads no gates on a work item while its step is in hand, when its push may not be recorded yet', async () => {
    const workItem = await ticket();
    let rounds = 0;
    const coder = AGENTS.coder as Agent;
    const { line: it, pass, steps, github } = line({ ...AGENTS, coder: (r) => (++rounds > 1 ? 'works on' : coder(r)) });
    await pass();
    await pass();
    github.pass(12, 'failure');
    await it.tick(); // the gates fail, and the coder's second round starts
    while (steps.working === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    // The coder has pushed, and checks are running on its commit, but the push is not recorded yet.
    const pr = github.pulls.get(12);
    if (pr) pr.head.sha = 'e'.repeat(40);
    github.pass();
    await it.tick();
    expect((await payloads(workItem, 'gates.started')).map((g) => g.commit)).not.toContain('e'.repeat(40));
    await steps.cancel();
    await it.idle();
  });

  it('ends a work item only once its volume is deleted, even one that ended while a step was in hand', async () => {
    const workItem = await ticket();
    const closed = event(workItem, 'work-item.closed', { outcome: 'no-change', reason: 'Closed by Martin' }, 'martin');
    const planner = AGENTS.planner as Agent;
    const { pass, steps } = line({
      ...AGENTS,
      planner: async (r) => {
        await events.append(closed);
        return planner(r);
      },
    });
    steps.finishFails = 1;
    await pass(); // the planner hands back after the work item closed
    expect(await stage(workItem)).toBe('plan');
    await pass(); // the volume cannot be deleted
    expect(steps.finished).toEqual([]);
    expect(await stage(workItem)).toBe('plan');
    await pass();
    expect(steps.finished).toEqual([workItem]);
    expect(await stage(workItem)).toBe('ended');
  });

  it('stops the step in hand when the line stops, records nothing of it, and runs it afresh when it starts', async () => {
    const workItem = await ticket();
    let stopped = false;
    const {
      line: it,
      steps,
      pass,
    } = line({ ...AGENTS, planner: () => (stopped ? (AGENTS.planner?.({} as never) ?? 'fails') : 'works on') });
    await it.tick();
    while (steps.working === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await events.append(event(null, 'line.stopped', { reason: 'Martin stopped the line' }, 'martin'));
    await it.tick();
    await it.idle();
    expect(steps.working).toBe(0);
    expect(await types(workItem)).toEqual(['work-item.opened', 'ticket.opened']);
    await pass(); // stopped: nothing starts
    expect(steps.requests).toHaveLength(1);

    stopped = true;
    await events.append(event(null, 'line.started', { autonomy: 'supervised' }, 'martin'));
    await pass();
    expect(steps.requests.map((r) => r.attempt)).toEqual([1, 2]);
    expect(await types(workItem)).toContain('spec.written');
  });
});
