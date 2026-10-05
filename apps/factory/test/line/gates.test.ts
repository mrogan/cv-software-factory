import { describe, expect, it } from 'vitest';
import type { CheckRun, PullRequestState } from '../../src/github/reads.ts';
import { APP_SLUG, gateEvents, gateRecord } from '../../src/line/gates.ts';

const SHA = 'a'.repeat(40);
const MERGED = 'c'.repeat(40);

const pr = (change: Partial<PullRequestState> = {}): PullRequestState => ({
  number: 12,
  state: 'open',
  merged: false,
  mergeCommit: null,
  mergedBy: null,
  head: { ref: 'factory/1001-search', sha: SHA },
  draft: true,
  nodeId: 'PR_12',
  ...change,
});

const run = (id: number, name: string, conclusion: string | null, app = 'github-actions'): CheckRun => ({
  id,
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion,
  app,
  startedAt: '2026-10-05T10:00:00Z',
  completedAt: conclusion ? '2026-10-05T10:02:00Z' : null,
  title: conclusion === 'failure' ? 'Two tests fail' : null,
});

const nothing = gateRecord([]);

describe('the gates, as events', () => {
  it('start with the required checks, and record each as it finishes', () => {
    const drafts = gateEvents(
      pr(),
      [run(1, 'test', 'success'), run(2, 'journeys', null)],
      ['test', 'journeys', 'lint'],
      nothing,
    );
    expect(drafts.map((d) => d.type)).toEqual(['gates.started', 'gate.finished']);
    expect(drafts[0]?.payload).toEqual({ pullRequest: 12, commit: SHA, checks: ['test', 'journeys', 'lint'] });
    expect(drafts[1]?.payload).toEqual({
      pullRequest: 12,
      commit: SHA,
      check: 'test',
      conclusion: 'success',
      required: true,
      durationMs: 120_000,
    });
  });

  it('finish when every required check and every other one has finished, failing on a required failure', () => {
    const record = gateRecord([
      { type: 'gates.started', payload: { commit: SHA } },
      { type: 'gate.finished', payload: { commit: SHA, check: 'test' } },
    ]);
    const runs = [run(1, 'test', 'success'), run(3, 'journeys', 'failure'), run(4, 'tests first', 'failure')];
    const drafts = gateEvents(pr(), runs, ['test', 'journeys', 'lint'], record);
    // Lint, required, has not started: not done yet.
    expect(drafts.map((d) => d.type)).toEqual(['gate.finished', 'gate.finished']);
    const done = gateEvents(pr(), [...runs, run(5, 'lint', 'success')], ['test', 'journeys', 'lint'], record);
    expect(done.at(-1)).toMatchObject({
      type: 'gates.finished',
      payload: { conclusion: 'failed', failed: ['journeys'], passed: 2 },
    });
    expect(done.find((d) => d.type === 'gate.finished' && d.payload.check === 'tests first')?.payload).toMatchObject({
      required: false,
      conclusion: 'failure',
      summary: 'Two tests fail',
    });
  });

  it('take a check run again by its latest run, and leave out the factory’s own', () => {
    const runs = [run(1, 'test', 'failure'), run(2, 'test', 'success'), run(3, 'factory review', null, APP_SLUG)];
    const drafts = gateEvents(pr(), runs, ['test'], nothing);
    expect(drafts.at(-1)).toMatchObject({ type: 'gates.finished', payload: { conclusion: 'passed', failed: [] } });
    expect(drafts[0]?.payload).toMatchObject({ checks: ['test'] });
  });

  it('append nothing they have already said, and nothing before a check has started', () => {
    expect(gateEvents(pr(), [], ['test'], nothing)).toEqual([]);
    const record = gateRecord([
      { type: 'gates.started', payload: { commit: SHA } },
      { type: 'gate.finished', payload: { commit: SHA, check: 'test' } },
      { type: 'gates.finished', payload: { commit: SHA } },
    ]);
    expect(gateEvents(pr(), [run(1, 'test', 'success')], ['test'], record)).toEqual([]);
  });

  it('record Martin’s merge, and close a work item whose pull request closed unmerged', () => {
    expect(
      gateEvents(pr({ state: 'closed', merged: true, mergeCommit: MERGED, mergedBy: 'mrogan' }), [], [], nothing),
    ).toEqual([
      {
        type: 'pull-request.merged',
        actor: 'martin',
        summary: 'Martin merged PR #12',
        payload: { number: 12, commit: MERGED, by: 'martin' },
      },
    ]);
    expect(gateEvents(pr({ state: 'closed' }), [], [], nothing)[0]).toMatchObject({
      type: 'work-item.closed',
      payload: { outcome: 'no-change' },
    });
    const merged = gateRecord([{ type: 'pull-request.merged', payload: {} }]);
    expect(gateEvents(pr({ state: 'closed', merged: true, mergeCommit: MERGED }), [], [], merged)).toEqual([]);
  });
});
