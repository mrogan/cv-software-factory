import { HOLD_CAUSES, type HoldCause, type PayloadOf } from '@software-factory/events';
import { describe, expect, it } from 'vitest';
import { ANSWERS, decide, type Facts, fold, LIMITS, type LineEvent, unchangedHold } from '../../src/line/machine.ts';

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
    criteria: [
      { given: 'a query with a quote', when: 'it is searched', expect: 'the page lists matches', from: 'the ticket' },
    ],
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
    whole: [{ path: 'src/search.ts', added: 1, removed: 1 }],
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
const finding = { path: 'src/search.ts', line: 3, blocking: true, rule: 4, comment: 'Escape the query once.' };
const review = (verdict: PayloadOf<'review.submitted'>['verdict']): LineEvent => ({
  type: 'review.submitted',
  payload: {
    pullRequest: 12,
    verdict,
    note: 'One blocking finding.',
    findings: verdict === 'approved' ? [] : [finding],
  },
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
      failed: ['test'],
    });
    expect(decide([...failed, returned('gates')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    let events = failed;
    for (let round = 1; round <= LIMITS.gateReturns; round++) {
      events = [...events, returned('gates'), pushed(round + 1), started(), finished('failed')];
    }
    expect(decide(events, facts)).toMatchObject({ stage: 'held', next: { do: 'hold', hold: { stage: 'gates' } } });
  });

  it('sends blocking findings back to the coder, reviews its second round, and holds what still blocks', () => {
    const passed = (attempt: number) => [pushed(attempt), started(), finished('passed')];
    // Round 1: the review blocks, and the work goes back to Build.
    const first = [ticket, spec, ...passed(1), review('changes-requested')];
    expect(decide(first, facts)).toEqual({
      stage: 'build',
      next: {
        do: 'return',
        from: 'review',
        to: 'build',
        reason: 'Review asked for changes: One blocking finding.',
        blocking: 1,
      },
    });
    // The coder's round 2, with the findings that sent it back still to hand.
    const back = [...first, returned('review')];
    expect(decide(back, facts)).toEqual({ stage: 'build', next: { do: 'step', agent: 'coder', round: 2 } });
    expect(fold(back).review?.findings).toEqual([finding]);
    // Its push waits for the gates, and a passing run brings the reviewer back for round 2, which knows round 1's.
    expect(decide([...back, pushed(2)], facts).next).toEqual({ do: 'wait', for: 'gates' });
    const reviewing = [...back, ...passed(2)];
    expect(decide(reviewing, facts)).toEqual({ stage: 'review', next: { do: 'step', agent: 'reviewer', round: 2 } });
    expect(fold(reviewing)).toMatchObject({ review: undefined, reviews: [{ findings: [finding] }] });
    // Round 2 still blocks: two reviews are the limit, and Martin decides.
    expect(LIMITS.reviews).toBe(2);
    expect(decide([...reviewing, review('changes-requested')], facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'review',
          kind: 'held',
          cause: 'review',
          reason: 'Review asked for changes: One blocking finding.',
        },
      },
    });
    // Round 2 approves: on to the describer, which reads the whole thread and the way back.
    const approved = [...reviewing, review('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'describer', round: 2 });
    expect(fold(approved).reviews.map((r) => r.verdict)).toEqual(['changes-requested', 'approved']);
    expect(fold(approved).returns).toEqual([{ from: 'review', reason: expect.any(String) }]);
    // An escalation holds at once.
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
    // Martin's answer to the hold sends the work item back to Plan (below), and the new spec starts the count again.
    const hold: LineEvent = {
      type: 'hold.started',
      payload: { stage: 'build', kind: 'held', cause: 'scope', reason: 'Twice outside its scope' },
    };
    const answered: LineEvent = { type: 'hold.answered', payload: { decision: 'answered', answer: 'Take it in' } };
    const respecified = [...once, refused(), hold, answered, spec];
    expect(decide(respecified, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(fold(respecified)).toMatchObject({ fenced: undefined, fenceRefusals: 0 });
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

  it('holds a work item that has spent its cap before its next step, with the cap, and not before', () => {
    const spend = { spentUsd: 5.03, limitUsd: 5 };
    expect(decide([ticket, spec], { ...facts, spend })).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'build',
          kind: 'held',
          cause: 'spend',
          reason: 'The work item has spent $5.03 on models, and may spend $5.00',
          limitUsd: 5,
        },
      },
    });
    // Under the cap the step runs; waiting for the gates needs no model.
    expect(decide([ticket, spec], { ...facts, spend: { ...spend, spentUsd: 4.99 } }).next).toMatchObject({
      do: 'step',
      agent: 'coder',
    });
    expect(decide([ticket, spec, pushed(), started()], { ...facts, spend }).next).toEqual({
      do: 'wait',
      for: 'gates',
    });
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
      held('failures', 'build'),
      answer('answered', 'Try again'),
    ];
    expect(fold(events).answers).toEqual([
      { asked: 'Which page?', answer: 'The home page' },
      { asked: 'Held for Martin', answer: 'It is in src/price.ts' },
    ]);
  });

  it('holds a spec tagged out-of-scope for his approval before anything is built, whatever the autonomy', () => {
    const wide: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), risks: ['out-of-scope'] },
    };
    expect(decide([ticket, wide], facts)).toEqual({
      stage: 'held',
      next: {
        do: 'hold',
        hold: {
          stage: 'plan',
          kind: 'approval',
          cause: 'spec',
          reason:
            'The spec is tagged out-of-scope: the fix changes behaviour beyond what the ticket is about, which needs Martin in every autonomy mode',
        },
      },
    });
    const approved = [ticket, wide, held('spec', 'plan'), answer('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    // Approved once, it stays approved as the work goes on; a new spec is a new question.
    expect(decide([...approved, pushed()], facts).next).toEqual({ do: 'wait', for: 'gates' });
    expect(decide([...approved, wide], facts).next).toMatchObject({ do: 'hold' });
    expect(decide([ticket, wide, held('spec', 'plan'), answer('answered', 'Only the search')], facts).next).toEqual({
      do: 'step',
      agent: 'planner',
      round: 1,
    });
  });

  it('holds a spec tagged out-of-scope written again after a push, then sends the coder to meet it', () => {
    const wide: LineEvent = {
      type: 'spec.written',
      payload: { ...(spec.payload as PayloadOf<'spec.written'>), risks: ['out-of-scope'] },
    };
    // The scope fence kept refusing a later round, and he sent the work back to the planner.
    const replanned = [ticket, spec, pushed(), returned('review'), held('scope', 'build'), answer('answered', 'Wider')];
    expect(decide(replanned, facts).next).toMatchObject({ do: 'step', agent: 'planner' });
    expect(decide([...replanned, wide], facts).next).toMatchObject({ do: 'hold', hold: { cause: 'spec' } });
    // A spec written again after a push, from a review he answered, sends the work back to the coder.
    const rewritten = [ticket, spec, pushed(), started(), finished('passed'), review('escalated'), spec];
    expect(decide(rewritten, facts).next).toEqual({
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'The planner wrote the spec again: the change is held to the new one',
    });
    expect(decide([...rewritten, returned('review')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
  });

  it('holds a review that cites the ticket as beyond it, and sends his answer to the planner, never the coder', () => {
    const beyond: LineEvent = {
      type: 'review.submitted',
      payload: {
        pullRequest: 12,
        verdict: 'escalated',
        note: 'Criterion 2 is not in the ticket.',
        findings: [{ ...finding, rule: undefined, criterion: 2, ticket: true }],
      },
    };
    const escalated = [ticket, spec, pushed(), started(), finished('passed'), beyond];
    expect(decide(escalated, facts).next).toMatchObject({
      do: 'hold',
      hold: { stage: 'review', cause: 'beyond-ticket' },
    });
    const answered = [...escalated, held('beyond-ticket', 'review'), answer('answered', 'Only the quote')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(decide([...answered, spec], facts).next).toMatchObject({ do: 'return', from: 'review', to: 'build' });
    const approved = [...escalated, held('beyond-ticket', 'review'), answer('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    // An escalation that does not cite the ticket keeps the review's cause.
    expect(
      decide([ticket, spec, pushed(), started(), finished('passed'), review('escalated')], facts).next,
    ).toMatchObject({
      hold: { cause: 'review' },
    });
  });

  it('leaves a defect the planner alone noticed waiting until he approves it, and plans the ticket triage then opens', () => {
    expect(decide([held('finding', 'triage'), answer('answered')], facts).next).toEqual({ do: 'wait', for: 'martin' });
    expect(decide([held('finding', 'triage'), answer('rejected')], facts).next).toMatchObject({ do: 'close' });
    const approved = [held('finding', 'triage'), answer('approved'), ticket];
    expect(decide(approved, { ...facts, issue: null })).toEqual({ stage: 'plan', next: { do: 'open-issue' } });
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
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

  it('runs a step that kept failing again, with his words', () => {
    const events = [ticket, spec, held('failures', 'build'), answer('answered', 'The tests are in test/')];
    expect(decide(events, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    // The coder's input takes them (`answerOf`), until the work item moves on.
    expect(fold(events).answer?.text).toBe('The tests are in test/');
    expect(fold([...events, pushed()]).answer).toBeUndefined();
  });

  it('sends a scope the coder kept straying from back to Plan, with what the fence printed and what he said', () => {
    const fenced = 'scope: src/search.ts, test/\nallowed src/search.ts +1 −1\nrefused src/cards.ts +2 −0';
    const refused: LineEvent = {
      type: 'action.refused',
      payload: { mechanism: 'scope-fence', action: 'Push the coder’s round 1 to a new pull request', output: fenced },
    };
    const strayed = [ticket, spec, refused, refused, held('scope', 'build')];
    const asked =
      'Held for Martin. The scope fence printed: scope: src/search.ts, test/; allowed src/search.ts +1 −1; refused src/cards.ts +2 −0.';
    const answered = [...strayed, answer('answered', 'The cards share the bug: take them in')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(fold(answered).answers).toEqual([{ asked, answer: 'The cards share the bug: take them in' }]);
    // Approving says the coder needed those files.
    const approved = [...strayed, answer('approved')];
    expect(decide(approved, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(fold(approved).answers).toEqual([
      { asked, answer: 'Yes: the coder needed those files, so let the scope take them in.' },
    ]);
    expect(decide([...strayed, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
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

  it('moves a review still blocking after the last round on by his answer: another round, his approval, or a close', () => {
    const second = [ticket, spec, pushed(1), started(), finished('passed'), review('changes-requested')];
    const last = [
      ...second,
      returned('review'),
      pushed(2),
      started(OTHER),
      finished('passed', OTHER),
      review('changes-requested'),
    ];
    const holding = decide(last, facts).next;
    expect(holding).toMatchObject({ do: 'hold', hold: { cause: 'review' } });
    const heldAtLast = [...last, held('review', 'review')];

    // An answer is another round: back to the coder with his words, then the gates and a fresh reviewer.
    const answered = [...heldAtLast, answer('answered', 'Escape it in the query builder')];
    expect(decide(answered, facts).next).toEqual({
      do: 'return',
      from: 'review',
      to: 'build',
      reason: 'Martin sent it back: Escape it in the query builder',
    });
    const third = [...answered, returned('review')];
    expect(decide(third, facts).next).toEqual({ do: 'step', agent: 'coder', round: 3 });
    expect(fold(third).rebuild).toEqual({ from: 'review', reason: 'Put it right' });
    expect(fold(third).review?.findings.filter((f) => f.blocking)).toEqual([finding]);
    const reviewed = [...third, pushed(3), started(SHA), finished('passed', SHA)];
    expect(decide(reviewed, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 3 });
    expect(decide([...reviewed, review('approved')], facts).next).toMatchObject({ agent: 'describer' });

    // His approval stands in for the reviewer's; rejecting closes the work item.
    expect(decide([...heldAtLast, answer('approved')], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 2,
    });
    expect(decide([...heldAtLast, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
  });

  it('runs a reviewer that kept failing again when he answers, and closes it when he rejects', () => {
    const failed = [ticket, spec, pushed(), started(), finished('passed'), held('failures', 'review')];
    expect(decide([...failed, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 1 });
    expect(decide([...failed, answer('answered', 'Try again')], facts).next).toEqual({
      do: 'step',
      agent: 'reviewer',
      round: 1,
    });
    expect(decide([...failed, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
  });

  it('runs a describer that kept failing again when he answers, and closes it when he rejects', () => {
    const failed = [
      ticket,
      spec,
      pushed(),
      started(),
      finished('passed'),
      review('approved'),
      held('failures', 'review'),
    ];
    for (const decision of [answer('approved'), answer('answered', 'Keep it short')]) {
      expect(decide([...failed, decision], facts).next).toEqual({ do: 'step', agent: 'describer', round: 1 });
    }
    expect(fold([...failed, answer('answered', 'Keep it short')]).answer?.text).toBe('Keep it short');
    expect(decide([...failed, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
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

  it('carries on from a spend hold when he approves, and holds again while the cap stands', () => {
    const spend = { spentUsd: 5.03, limitUsd: 5 };
    const capped = [ticket, spec, held('spend', 'build'), answer('approved')];
    expect(decide(capped, facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
    expect(decide(capped, { ...facts, spend }).next).toMatchObject({ do: 'hold', hold: { cause: 'spend' } });
  });

  it('accepts tests that pass without the fix when he approves, and sends them back when he answers', () => {
    const tests = [ticket, spec, pushed(), started(), finished('passed'), held('tests-first', 'gates')];
    expect(decide([...tests, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 1 });
    expect(decide([...tests, answer('answered', 'Test the Friday case')], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'Martin sent it back: Test the Friday case',
    });
  });

  it('reviews a change whose gates pass after they sent it back, on a branch the coder did not move', () => {
    // The branch was brought up to date with main while the coder found nothing to change, and held.
    const returnedThenHeld = [ticket, spec, pushed(), started(), finished('failed'), returned('gates')];
    expect(decide(returnedThenHeld, facts).next).toEqual({ do: 'step', agent: 'coder', round: 2 });
    const passed = [...returnedThenHeld, started(OTHER), finished('passed', OTHER)];
    expect(decide(passed, facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 2 });
    const waiting = [...returnedThenHeld, held('failures', 'build'), started(OTHER), finished('passed', OTHER)];
    expect(decide([...waiting, answer('approved')], facts).next).toEqual({ do: 'step', agent: 'reviewer', round: 2 });
    // A return from review stands, whatever the gates do.
    const fromReview = [
      ticket,
      spec,
      pushed(),
      started(),
      finished('passed'),
      review('changes-requested'),
      returned('review'),
    ];
    expect(decide([...fromReview, started(OTHER), finished('passed', OTHER)], facts).next).toMatchObject({
      agent: 'coder',
    });
  });

  it('ignores an answer when nothing is held', () => {
    expect(decide([ticket, spec, answer('rejected')], facts).next).toEqual({ do: 'step', agent: 'coder', round: 1 });
  });
});

describe('a coder that changes nothing, and says why', () => {
  const why = 'The journeys fail on the basket’s total, which this change leaves alone.';
  const unchanged = (events: LineEvent[]): LineEvent => ({
    type: 'hold.started',
    payload: unchangedHold(fold(events), why),
  });

  it('holds where the work came back from, under that stage’s cause, with its reason', () => {
    const back = [ticket, spec, pushed(), started(), finished('failed'), returned('gates')];
    expect(unchangedHold(fold(back), why)).toEqual({
      stage: 'gates',
      kind: 'held',
      cause: 'gates',
      reason: `The coder changed nothing when the work came back from gates: ${why}`,
    });
    const reviewed = [ticket, spec, pushed(), started(), finished('passed'), review('changes-requested')];
    expect(unchangedHold(fold([...reviewed, returned('review')]), why)).toMatchObject({
      stage: 'review',
      cause: 'review',
    });
    // A first round has nothing returned to it: the code already does what the spec asks, which questions the spec.
    expect(unchangedHold(fold([ticket, spec]), why)).toEqual({
      stage: 'build',
      kind: 'held',
      cause: 'nothing-to-fix',
      reason: `The coder found nothing to fix: ${why}`,
    });
    expect(unchangedHold(fold([ticket, spec]), 'x'.repeat(400)).reason).toHaveLength(300);
  });

  it('waits for Martin, then does as he answers a hold of the gates’: back to the coder, or closed', () => {
    const back = [ticket, spec, pushed(), started(), finished('failed'), returned('gates')];
    const holding = [...back, unchanged(back)];
    expect(decide(holding, facts)).toEqual({ stage: 'held', next: { do: 'wait', for: 'martin' } });
    expect(decide([...holding, answer('answered', 'Fix the total too')], facts).next).toEqual({
      do: 'return',
      from: 'gates',
      to: 'build',
      reason: 'Martin sent it back: Fix the total too',
    });
    expect(decide([...holding, answer('approved')], facts).next).toMatchObject({ do: 'return', from: 'gates' });
    expect(decide([...holding, answer('rejected')], facts).next).toMatchObject({ do: 'close' });
    // Sent back, the coder's next round starts.
    const again = [...holding, answer('answered', 'Fix the total too'), returned('gates')];
    expect(decide(again, facts).next).toEqual({ do: 'step', agent: 'coder', round: 3 });
  });

  it('takes his approval of a hold after review in place of the reviewer’s: the coder has nothing left to do', () => {
    const reviewed = [ticket, spec, pushed(), started(), finished('passed'), review('changes-requested')];
    const back = [...reviewed, returned('review')];
    const holding = [...back, unchanged(back)];
    expect(decide([...holding, answer('approved')], facts).next).toEqual({
      do: 'step',
      agent: 'describer',
      round: 2,
    });
    expect(fold([...holding, answer('approved')]).rebuild).toBeUndefined();
    expect(decide([...holding, answer('answered', 'Do as the reviewer asks')], facts).next).toMatchObject({
      do: 'return',
      from: 'review',
      reason: 'Martin sent it back: Do as the reviewer asks',
    });
  });

  it('closes a first round that found nothing to fix when he agrees, and has the planner write the spec again when he answers', () => {
    const holding = [ticket, spec, unchanged([ticket, spec])];
    expect(decide([...holding, answer('approved')], facts)).toEqual({
      stage: 'held',
      next: { do: 'close', reason: 'Martin agreed with the coder' },
    });
    const answered = [...holding, answer('answered', 'It breaks on a basket of one')];
    expect(decide(answered, facts).next).toEqual({ do: 'step', agent: 'planner', round: 1 });
    expect(fold(answered).answers).toEqual([
      { asked: `The coder found nothing to fix: ${why}`, answer: 'It breaks on a basket of one' },
    ]);
  });
});
