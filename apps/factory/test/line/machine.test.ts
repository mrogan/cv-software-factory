import type { PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { decide, type Facts, LIMITS, type LineEvent } from '../../src/line/machine.ts';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

const ticket: LineEvent = {
  type: 'ticket.opened',
  payload: {
    title: 'Server errors on /search',
    category: 'errors',
    severity: 'broken',
    fingerprint: { route: '/search', class: 'server-error' },
    traces: [],
  },
};
const spec: LineEvent = {
  type: 'spec.written',
  payload: {
    outcome: 'Search answers every query.',
    criteria: [{ given: 'a query with a quote', when: 'it is searched', expect: 'the page lists matches' }],
    scope: ['src/search.ts', 'test/'],
    risks: [],
    rollout: 'Ships as it is.',
  },
};
const pushed = (attempt = 1): LineEvent => ({
  type: 'pull-request.pushed',
  payload: {
    number: 12,
    title: 'fix(search): escape the query',
    branch: 'factory/1001-server-errors-on-search',
    attempt,
    testsFirst: true,
    files: [{ path: 'src/search.ts', added: 1, removed: 1 }],
  },
});
const started = (commit = SHA): LineEvent => ({
  type: 'gates.started',
  payload: { pullRequest: 12, commit, checks: ['test'] },
});
const finished = (conclusion: 'passed' | 'failed', commit = SHA): LineEvent => ({
  type: 'gates.finished',
  payload: { pullRequest: 12, commit, conclusion, passed: 1, failed: conclusion === 'failed' ? ['test'] : [] },
});
const review = (verdict: PayloadOf<'review.submitted'>['verdict']): LineEvent => ({
  type: 'review.submitted',
  payload: { pullRequest: 12, verdict, comments: 1, note: 'One blocking finding.' },
});
const returned = (from: 'gates' | 'review'): LineEvent => ({
  type: 'work.returned',
  payload: { from, to: 'build', reason: 'Put it right' },
});
const summarised: LineEvent = {
  type: 'work-item.summarised',
  payload: { title: 'Search answers every query', description: 'Fixed.', story: 'The factory fixed it.' },
};

const facts: Facts = { issue: 3, failures: 0, failure: null };

describe('what the line does next', () => {
  it('opens the issue as a ticket enters Plan, then plans it', () => {
    expect(decide([ticket], { ...facts, issue: null })).toEqual({ stage: 'plan', next: { do: 'open-issue' } });
    expect(decide([ticket], facts)).toEqual({ stage: 'plan', next: { do: 'step', agent: 'planner', round: 1 } });
  });

  it('builds a spec, waits for the gates, reviews what passes, describes what review approves, and waits for Martin', () => {
    expect(decide([ticket, spec], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(decide([ticket, spec, pushed()], facts)).toEqual({ stage: 'gates', next: { do: 'wait', for: 'gates' } });
    expect(decide([ticket, spec, pushed(), started()], facts).next).toEqual({ do: 'wait', for: 'gates' });
    const passed = [ticket, spec, pushed(), started(), finished('passed')];
    expect(decide(passed, facts)).toEqual({ stage: 'review', next: { do: 'step', agent: 'reviewer', round: 1 } });
    expect(decide([...passed, review('approved')], facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    expect(decide([...passed, review('approved'), summarised], facts)).toMatchObject({
      stage: 'held',
      next: { do: 'hold', hold: { stage: 'review', kind: 'approval' } },
    });
  });

  it('sends failing gates back to the coder, whose next round resumes, and holds after the limit', () => {
    const failed = [ticket, spec, pushed(), started(), finished('failed')];
    expect(decide(failed, facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'The gates failed: test',
    });
    expect(decide([...failed, returned('gates')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    let events = failed;
    for (let round = 1; round <= LIMITS.gateReturns; round++) {
      events = [...events, returned('gates'), pushed(round + 1), started(), finished('failed')];
    }
    expect(decide(events, facts)).toMatchObject({ stage: 'held', next: { do: 'hold', hold: { stage: 'gates' } } });
  });

  it('sends blocking findings back, and holds what still blocks after two reviews', () => {
    const passed = (attempt: number) => [pushed(attempt), started(), finished('passed')];
    const first = [ticket, spec, ...passed(1), review('changes-requested')];
    expect(decide(first, facts).next).toMatchObject({ do: 'return', from: 'review', to: 'build' });
    const second = [...first, returned('review'), ...passed(2), review('changes-requested')];
    expect(LIMITS.reviews).toBe(2);
    expect(decide(second, facts)).toMatchObject({ stage: 'held', next: { do: 'hold', hold: { kind: 'held' } } });
    expect(decide([ticket, spec, ...passed(1), review('escalated')], facts)).toMatchObject({ stage: 'held' });
  });

  it('judges the gates on the latest push only, and ignores a later run once they have passed', () => {
    const later = [ticket, spec, pushed(), started(), finished('passed'), started(OTHER), finished('failed', OTHER)];
    expect(decide(later, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 1 });
    const stale = [ticket, spec, pushed(), started(), finished('failed', OTHER)];
    expect(decide(stale, facts).next).toEqual({ do: 'wait', for: 'gates' });
  });

  it('holds a step that keeps failing, and waits on any hold until it is answered', () => {
    expect(decide([ticket, spec], { ...facts, failures: LIMITS.failures, failure: 'no result' })).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: { stage: 'build', kind: 'held', cause: 'failures', reason: 'The coder failed 2 times: no result' },
      },
    });
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'plan', kind: 'question', cause: 'question', reason: 'Which page?' },
    };
    expect(decide([ticket, hold], facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    const answered: LineEvent = { type: 'hold.answered', payload: { decision: 'answered', answer: 'The home page' } };
    expect(decide([ticket, hold, answered], facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
  });

  it('ends a work item that is merged, or closed', () => {
    const merged: LineEvent = { type: 'pull-request.merged', payload: { number: 12, commit: OTHER, by: 'martin' } };
    expect(decide([ticket, spec, pushed(), merged], facts)).toEqual({ stage: 'ended', next: { do: 'finish' } });
    const closed: LineEvent = {
      type: 'work-item.closed',
      payload: { outcome: 'no-change', reason: 'Closed unmerged' },
    };
    expect(decide([ticket, closed], facts)).toEqual({ stage: 'ended', next: { do: 'finish' } });
  });
});
