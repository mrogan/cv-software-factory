import { HOLD_CAUSES, type HoldCause, type PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { ANSWERS, decide, type Facts, fold, LIMITS, type LineEvent } from '../../src/line/machine.ts';

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

  it('sends a patch the scope fence refuses back to the coder once, with its output, and holds at the second', () => {
    const refused = (output = 'scope: src/search.ts, test/\nrefused src/server.ts +1 −1'): LineEvent => ({
      type: 'action.refused',
      payload: { mechanism: 'scope-fence', action: 'Push the coder’s round 1 to a new pull request', output },
    });
    const once = [ticket, spec, refused()];
    expect(decide(once, facts)).toEqual({ stage: 'build', next: { do: 'step', agent: 'coder', round: 1 } });
    expect(fold(once).fenced).toBe('scope: src/search.ts, test/\nrefused src/server.ts +1 −1');
    expect(decide([...once, refused()], facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'build',
          kind: 'held',
          cause: 'scope',
          reason: 'The scope fence refused the coder’s patch 2 times: it changed files outside the spec’s scope',
        },
      },
    });
    expect(LIMITS.fenceRefusals).toBe(2);
    // A push clears the refusal it followed, but the count stays: a later round that strays once more holds.
    const pushedAfter = [...once, pushed(), started(), finished('failed'), returned('gates')];
    expect(fold(pushedAfter).fenced).toBeUndefined();
    expect(decide(pushedAfter, facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    expect(decide([...pushedAfter, refused()], facts)).toMatchObject({ stage: 'held' });
    // Martin's answer to the hold gives the coder its next go, with the fence's last output.
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'build', kind: 'held', cause: 'scope', reason: 'Twice outside its scope' },
    };
    const answered: LineEvent = { type: 'hold.answered', payload: { decision: 'answered', answer: 'Try again' } };
    const after = [...once, refused(), hold, answered];
    expect(decide(after, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(fold(after).fenced).toContain('refused src/server.ts');
    // The platform's refusals are not the fence's.
    const ruleset: LineEvent = {
      type: 'action.refused',
      payload: { mechanism: 'ruleset', action: 'Push to main', output: 'Protected branch' },
    };
    expect(fold([ticket, spec, ruleset, ruleset]).fenceRefusals).toBe(0);
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

const held = (cause: HoldCause, stage: PayloadOf<'hold.started'>['stage']): LineEvent => ({
  type: 'hold.started',
  payload: { stage, kind: cause === 'merge' ? 'approval' : 'held', cause, reason: 'Held for Martin' },
});
const answer = (decision: PayloadOf<'hold.answered'>['decision'], text?: string): LineEvent => ({
  type: 'hold.answered',
  payload: { decision, ...(text ? { answer: text } : {}) },
});

describe('Martin’s answer to a hold', () => {
  const approvedAndDescribed = [ticket, spec, pushed(), started(), finished('passed'), review('approved'), summarised];

  it('has a rule for every cause and every answer', () => {
    for (const cause of HOLD_CAUSES) {
      expect(Object.keys(ANSWERS[cause]).sort()).toEqual(['answered', 'approved', 'rejected']);
    }
  });

  it('closes the work item when he rejects it, whatever the cause', () => {
    for (const cause of HOLD_CAUSES) {
      expect(decide([ticket, spec, held(cause, 'build'), answer('rejected', 'Not worth it')], facts)).toEqual({
        stage: 'held',
        next: { do: 'close', reason: 'Martin rejected it: Not worth it' },
      });
    }
  });

  it('runs the planner again on an answer to its question or its rejection', () => {
    for (const cause of ['question', 'ticket-rejected'] as const) {
      expect(decide([ticket, held(cause, 'plan'), answer('answered', 'The home page')], facts).next).toEqual({
        do: 'step',
        agent: 'planner',
        round: 1,
      });
    }
    // Approving a question asks the planner to carry on as it sees fit.
    expect(decide([ticket, held('question', 'plan'), answer('approved')], facts).next).toMatchObject({
      do: 'step',
      agent: 'planner',
    });
  });

  it('closes the work item when he agrees with the planner’s rejection, or rejects the ticket himself', () => {
    for (const [decision, reason] of [
      ['approved', 'Martin agreed with the planner'],
      ['rejected', 'Martin rejected it'],
    ] as const) {
      expect(decide([ticket, held('ticket-rejected', 'plan'), answer(decision)], facts)).toEqual({
        stage: 'held',
        next: { do: 'close', reason },
      });
    }
  });

  it('keeps every answer at Plan, with what he was asked, whatever kind of hold it answered', () => {
    const asked: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'plan', kind: 'question', cause: 'question', reason: 'A question', question: 'Which page?' },
    };
    const events = [
      ticket,
      asked,
      answer('answered', 'The home page'),
      held('ticket-rejected', 'plan'),
      answer('answered', 'It is in src/price.ts'),
      // An answer with no words, and one to a hold after Plan, are not the planner's.
      held('question', 'plan'),
      answer('approved'),
      spec,
      held('scope', 'build'),
      answer('answered', 'Try again'),
    ];
    expect(fold(events).answers).toEqual([
      { asked: 'Which page?', answer: 'The home page' },
      { asked: 'Held for Martin', answer: 'It is in src/price.ts' },
    ]);
  });

  it('has the planner write a spec again when he answers it, and builds it when he approves', () => {
    expect(decide([ticket, spec, held('spec', 'plan'), answer('answered', 'Smaller')], facts).next).toMatchObject({
      do: 'step',
      agent: 'planner',
    });
    expect(decide([ticket, spec, held('spec', 'plan'), answer('approved')], facts).next).toMatchObject({
      do: 'step',
      agent: 'coder',
    });
  });

  it('runs the step it was held at again, for a change outside its scope or a step that kept failing', () => {
    for (const cause of ['scope', 'failures'] as const) {
      expect(decide([ticket, spec, held(cause, 'build'), answer('answered', 'Try again')], facts).next).toEqual({
        do: 'step',
        agent: 'coder',
        round: 1,
      });
    }
  });

  it('sends the work back to the coder, with his words, from gates that kept failing', () => {
    const gates = [ticket, spec, pushed(), started(), finished('failed'), held('gates', 'gates')];
    expect(decide([...gates, answer('answered', 'The test is wrong')], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'Martin sent it back: The test is wrong',
    });
    // Once it has gone back, the coder works the next round.
    const back = [...gates, answer('answered', 'The test is wrong'), returned('gates')];
    expect(decide(back, facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
  });

  it('takes his approval of a held review in place of the reviewer’s', () => {
    const escalated = [
      ticket,
      spec,
      pushed(),
      started(),
      finished('passed'),
      review('escalated'),
      held('review', 'review'),
    ];
    expect(decide([...escalated, answer('approved')], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 1,
    });
    expect(decide([...escalated, answer('answered', 'Rename it')], facts).next).toMatchObject({
      do: 'return',
      from: 'review',
    });
  });

  it('waits for his merge when he approves it, and sends it back when he answers', () => {
    const merge = [...approvedAndDescribed, held('merge', 'review')];
    expect(decide([...merge, answer('approved')], facts)).toEqual({
      stage: 'held',
      next: { do: 'wait', for: 'martin' },
    });
    expect(decide([...merge, answer('answered', 'Add a test')], facts).next).toMatchObject({
      do: 'return',
      from: 'review',
      reason: 'Martin sent it back: Add a test',
    });
  });

  it('ignores an answer when nothing is held', () => {
    expect(decide([ticket, spec, answer('rejected')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
  });
});
