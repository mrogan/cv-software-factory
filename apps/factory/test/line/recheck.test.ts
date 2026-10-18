/**
 * The line looking again at held and waiting work items: after a release that did not carry their fix, and at the end
 * of a wait for a spec that overlaps one in flight.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NewEvent, type PayloadOf, VERSIONS } from '@software-factory/events';
import { DiskArtifacts, EventWriter, nextWorkItem } from '@software-factory/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Database, freshDatabase } from '../../../../packages/store/test/database.ts';
import { Line, type LineOptions } from '../../src/line/worker.ts';
import type { VerifyAnswer } from '../../src/probes/verify.ts';
import { quiet } from '../github/fake.ts';
import { CANARY, commitOf, STABLE } from '../release/fixtures.ts';
import { FakeGitHub, FakeProbes, FakeSteps, MAIN } from './fakes.ts';

let database: Database;
let events: EventWriter;
let now = Date.parse('2026-10-17T13:00:00Z');
beforeEach(async () => {
  database = await freshDatabase('recheck');
  events = new EventWriter(database.writer, {
    kind: 'real',
    artifacts: new DiskArtifacts(mkdtempSync(join(tmpdir(), 'artifacts-'))),
  });
  now = Date.parse('2026-10-17T13:00:00Z');
});
afterEach(() => database?.end());

const event = <K extends NewEvent['type']>(
  workItem: string | null,
  type: K,
  payload: PayloadOf<K>,
  actor: NewEvent['actor'] = 'factory',
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

const NEW = commitOf(CANARY);
const OLD = commitOf(STABLE);
const SCOPE = ['src/departments.ts', 'test/departments.test.ts'];

/** A ticket a probe saw on the version before, with its spec, on the line at `stage`, with issue `issue`. */
async function planned(stage: string, issue: number, scope = SCOPE): Promise<string> {
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
      { sense: 'probe', check: 'departments', route: '/departments/:department', version: OLD },
      'probe',
    ),
    event(
      workItem,
      'spec.written',
      {
        outcome: 'Each department page loads.',
        criteria: [{ given: 'a department', when: 'it is opened', expect: 'it loads', from: 'the ticket' }],
        scope,
        risks: [],
        rollout: 'Ships as it is.',
      },
      'planner',
    ),
  ]);
  await database.writer`insert into line (work_item, stage, issue) values (${workItem}, ${stage}, ${issue})`;
  return workItem;
}

/** A planned work item whose pull request #`number` is open, held for `cause`. */
async function held(cause: PayloadOf<'hold.started'>['cause'], github: FakeGitHub, number = 12): Promise<string> {
  const workItem = await planned('held', number - 1);
  const stage = cause === 'merge' ? 'review' : 'gates';
  await events.append([
    event(
      workItem,
      'pull-request.pushed',
      {
        number,
        title: 'fix(departments): stop the redirect loop',
        branch: `factory/${workItem}-a-redirect-loop`,
        attempt: 1,
        testsFirst: true,
        files: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
        whole: [{ path: 'src/departments.ts', added: 1, removed: 1 }],
      },
      'coder',
    ),
    event(workItem, 'hold.started', {
      stage,
      kind: cause === 'merge' ? 'approval' : 'held',
      cause,
      reason: 'Held for the test',
    }),
  ]);
  github.pulls.set(number, {
    number,
    state: 'open',
    merged: false,
    mergeCommit: null,
    mergedBy: null,
    head: { ref: `factory/${workItem}-a-redirect-loop`, sha: 'f'.repeat(40) },
    base: { ref: 'main', sha: MAIN },
    draft: false,
    nodeId: `PR_${number}`,
  });
  return workItem;
}

/** A release of `version` promoted, carrying `carrying` or on the line itself. */
async function promoted(carrying: string | null, release = 'f00dfeed01', version = NEW, dryRun = false) {
  const payload = { release, version, previous: OLD, commit: version, watched: !dryRun, dryRun };
  const image = { digest: `sha256:${'d'.repeat(64)}`, signed: true, admitted: true };
  await events.append([
    event(carrying, 'release.started', { ...payload, steps: null, ...(dryRun ? {} : { image }) }, 'rollouts'),
    event(carrying, 'release.promoted', payload, 'rollouts'),
  ]);
}

const CLEARED: VerifyAnswer = { outcome: 'cleared', version: NEW, runs: ['passed', 'passed'] };

function line(probes: FakeProbes, options: Partial<LineOptions> = {}) {
  const github = new FakeGitHub();
  const it = new Line({
    sql: database.writer,
    events,
    steps: new FakeSteps(database.writer, {}),
    github,
    log: quiet,
    me: 'test',
    now: () => new Date(now),
    release: null,
    verify: { probes },
    ...options,
  });
  return { line: it, github };
}

const pass = async (it: Line) => {
  await it.tick();
  await it.idle();
};

const payloads = async <K extends NewEvent['type']>(workItem: string, type: K) =>
  (
    await database.writer<{ payload: PayloadOf<K> }[]>`
      select payload from events where work_item = ${workItem} and type = ${type} order by seq`
  ).map((r) => r.payload);

const stage = async (workItem: string) =>
  (await database.writer<{ stage: string }[]>`select stage from line where work_item = ${workItem}`)[0]?.stage;

describe('a held work item looked at again after a release', () => {
  it('closes a hold of the line’s own as verified when the signal cleared, with its issue and pull request', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('gates', github);
    // Another work item's fix, which the line no longer has in hand.
    const other = await nextWorkItem(database.writer);
    await events.append([
      event(other, 'work-item.opened', { kind: 'defect-fix', title: 'Another', sample: false }, 'triage'),
    ]);
    await promoted(other);
    await pass(it); // the probe looks again
    expect(await payloads(workItem, 'signal.rechecked')).toEqual([
      {
        for: 'release',
        outcome: 'cleared',
        sense: 'probe',
        check: 'departments',
        release: 'f00dfeed01',
        version: NEW,
        against: OLD,
        carried: [other],
      },
    ]);
    expect(probes.asked).toEqual([{ sense: 'probe', check: 'departments', route: '/departments/:department' }]);
    await pass(it); // and the work item closes
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      {
        outcome: 'verified',
        reason: `The probe’s check “departments” passed twice in a row on ${NEW.slice(0, 7)}, a release that carried work item #${other}, not this one’s fix`,
      },
    ]);
    const acts = github.acts.filter((a) => a.action === 'closeIssue' || a.action === 'closePullRequest');
    expect(acts.map((a) => [a.action, a.args.number])).toEqual([
      ['closeIssue', 11],
      ['closePullRequest', 12],
    ]);
    expect(acts[0]?.args).toMatchObject({
      reason: 'completed',
      comment: expect.stringMatching(/^Verified in production/),
    });
    expect(acts[1]?.args.comment).toMatch(/^Closed unmerged: the defect this fixes is gone from production\./);
    expect(github.pulls.get(12)?.state).toBe('closed');
    // Its pull request, closed, says nothing more.
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toHaveLength(1);
  });

  it('records the look on a hold for Martin’s merge, and closes it as verified when he closes its pull request', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('merge', github);
    await promoted(null);
    await pass(it);
    await pass(it);
    expect(await payloads(workItem, 'signal.rechecked')).toMatchObject([{ outcome: 'cleared', carried: [] }]);
    expect(await payloads(workItem, 'work-item.closed')).toEqual([]);
    expect(await stage(workItem)).toBe('held');
    expect(github.acts.map((a) => a.action)).toEqual([]);
    // Martin closes it in GitHub.
    const pull = github.pulls.get(12);
    if (pull) pull.state = 'closed';
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toEqual([
      expect.objectContaining({ outcome: 'verified', reason: expect.stringMatching(/none of the factory’s fixes$/) }),
    ]);
    expect(github.acts.map((a) => [a.action, a.args.reason])).toEqual([['closeIssue', 'completed']]);
  });

  it('closes with no change when he closes it after a signal on that version ended the clearance', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const workItem = await held('merge', github);
    await promoted(null);
    await pass(it);
    await events.append([
      event(
        workItem,
        'signal.received',
        { sense: 'probe', check: 'departments', route: '/departments/:department', version: NEW },
        'probe',
      ),
    ]);
    const pull = github.pulls.get(12);
    if (pull) pull.state = 'closed';
    now += 60_000;
    await pass(it);
    expect(await payloads(workItem, 'work-item.closed')).toMatchObject([{ outcome: 'no-change' }]);
  });

  it('looks at nothing for a dry run’s release, nor for a release a signal was seen on', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes, { dryRun: true });
    const workItem = await held('gates', github);
    await promoted(null, 'dry-run-1', 'e'.repeat(40), true);
    await pass(it);
    expect(probes.asked).toEqual([]);
    await promoted(null, 'f00dfeed01');
    await events.append([
      event(
        workItem,
        'signal.received',
        { sense: 'probe', check: 'departments', route: '/departments/:department', version: NEW },
        'probe',
      ),
    ]);
    await pass(it);
    expect(probes.asked).toEqual([]);
    expect(await payloads(workItem, 'signal.rechecked')).toEqual([]);
  });

  it('looks again when a sense cannot tell, and stops after the policy’s wait, recording nothing', async () => {
    const probes = new FakeProbes({ outcome: 'unsure', version: NEW, runs: ['unsure'], message: 'timed out' });
    const { line: it, github } = line(probes, { verifyEveryMs: 60_000, verifyWaitMs: 3_600_000 });
    const workItem = await held('gates', github);
    await promoted(null);
    await pass(it);
    await pass(it);
    expect(probes.asked).toHaveLength(1);
    now += 60_000;
    await pass(it);
    expect(probes.asked).toHaveLength(2);
    now += 3_600_000;
    await pass(it);
    expect(probes.asked).toHaveLength(2);
    expect(await payloads(workItem, 'signal.rechecked')).toEqual([]);
  });

  it('looks at one work item at a time across the line', async () => {
    const probes = new FakeProbes({ outcome: 'persists', version: NEW, runs: ['failed', 'failed'] });
    const { line: it, github } = line(probes);
    const first = await held('gates', github, 12);
    const second = await held('gates', github, 14);
    await promoted(null);
    await pass(it);
    const looked = async () =>
      (await payloads(first, 'signal.rechecked')).length + (await payloads(second, 'signal.rechecked')).length;
    expect(await looked()).toBe(1);
    await pass(it);
    expect(await looked()).toBe(2);
    // A signal that persists leaves both held.
    expect([await stage(first), await stage(second)]).toEqual(['held', 'held']);
  });
});

describe('a spec that overlaps work in flight', () => {
  it('waits after Plan, and closes as verified when the work it waited on is verified and its signal is gone', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it, github } = line(probes);
    const first = await held('merge', github);
    const second = await planned('plan', 30, ['src/departments.ts']);
    await pass(it);
    expect(await payloads(second, 'wait.started')).toEqual([
      {
        on: [first],
        files: ['src/departments.ts'],
        reason: `Waits for #${first}, whose spec also changes src/departments.ts`,
      },
    ]);
    expect(await stage(second)).toBe('waiting');
    // The first merges, is released and verified.
    await events.append([event(first, 'pull-request.merged', { number: 12, commit: 'c'.repeat(40), by: 'martin' })]);
    await promoted(first);
    await events.append([event(first, 'work-item.closed', { outcome: 'verified', reason: 'Its fix cleared it' })]);
    await pass(it); // the second looks again, as its wait ends (and the release would set off a look too)
    expect(await payloads(second, 'signal.rechecked')).toMatchObject([
      { outcome: 'cleared', version: NEW, carried: [first] },
    ]);
    await pass(it);
    expect(await payloads(second, 'work-item.closed')).toMatchObject([{ outcome: 'verified' }]);
    expect(github.acts.filter((a) => a.action === 'closeIssue').map((a) => a.args.number)).toEqual([30]);
    expect(github.acts.filter((a) => a.action === 'closePullRequest')).toEqual([]);
  });

  it('goes on to Build when its signal is still there once the work it waited on closed', async () => {
    const probes = new FakeProbes({ outcome: 'persists', version: OLD, runs: ['failed', 'failed'] });
    const { line: it, github } = line(probes);
    const first = await held('merge', github);
    const second = await planned('plan', 30, ['src/departments.ts']);
    await promoted(null, 'f00dfeed00', OLD);
    await pass(it);
    expect(await stage(second)).toBe('waiting');
    await events.append([event(first, 'work-item.closed', { outcome: 'no-change', reason: 'Martin closed it' })]);
    await pass(it);
    expect(await payloads(second, 'signal.rechecked')).toMatchObject([{ for: 'wait', outcome: 'persists' }]);
    await pass(it);
    // The coder is asked for: the fake has none, so the step fails, but the work item is at Build.
    expect(await stage(second)).toBe('build');
  });

  it('never waits on a work item that waits on it, and not at all for a line of one', async () => {
    const probes = new FakeProbes(CLEARED);
    const { line: it } = line(probes);
    // The first came back to Plan with a new spec, and the second already waits on it.
    const first = await planned('plan', 20, ['src/departments.ts']);
    const second = await planned('waiting', 30, ['src/departments.ts']);
    const reason = `Waits for #${first}, whose spec also changes src/departments.ts`;
    await events.append([event(second, 'wait.started', { on: [first], files: ['src/departments.ts'], reason })]);
    await pass(it);
    expect(await payloads(first, 'wait.started')).toEqual([]);
    expect(await stage(first)).toBe('build');

    const third = await planned('plan', 31, ['src/departments.ts']);
    await pass(line(probes, { only: third }).line);
    expect(await payloads(third, 'wait.started')).toEqual([]);
  });
});
