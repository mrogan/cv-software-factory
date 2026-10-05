/**
 * What the line does next with a work item, decided from its events alone. A pure function, so a test drives it with
 * a list of events, and a line that stopped or crashed carries on from the last event it appended: nothing about a
 * work item's progress lives anywhere else.
 *
 *     ticket → [issue] → planner → spec → coder → pull request → gates → reviewer → describer → Martin's merge
 *                                            ▲                      │          │
 *                                            └──── work returned ───┴──────────┘
 *
 * The events are folded into where the work item is (`fold`), and `decide` turns that into one next action. Each
 * action either appends events, which moves the work item on, or waits for something outside the line: the gates
 * (GitHub's checks, which the line reads and appends as events) or Martin. The bounds a step has (its turns and
 * deadline) are each agent's (`agents/`); the bounds on the loop are `LIMITS`.
 */
import type { PayloadOf, Stage } from '@software-factory/events';

/** The agents the line runs, each in a runner. */
export type LineAgent = 'planner' | 'coder' | 'reviewer' | 'describer';

/** How far the line lets a work item go round before it holds for Martin. */
export const LIMITS = {
  /** Reviews a work item has: blocking findings after the last of them hold it (the decisions: two rounds). */
  reviews: 2,
  /** Times failing gates send the coder back before the work item holds. */
  gateReturns: 2,
  /** Failed attempts at one step (no handback, no result, a result its schema refuses) before it holds. */
  failures: 2,
} as const;

/** An event as the line reads it: its type and payload, upcast to the current version. */
export type LineEvent = { [K in keyof Payloads]: { type: K; payload: Payloads[K] } }[keyof Payloads];

type Payloads = {
  [K in
    | 'ticket.opened'
    | 'spec.written'
    | 'pull-request.pushed'
    | 'gates.started'
    | 'gates.finished'
    | 'review.submitted'
    | 'work-item.summarised'
    | 'work.returned'
    | 'hold.started'
    | 'hold.answered'
    | 'pull-request.merged'
    | 'work-item.closed']: PayloadOf<K>;
};

export const LINE_EVENT_TYPES = [
  'ticket.opened',
  'spec.written',
  'pull-request.pushed',
  'gates.started',
  'gates.finished',
  'review.submitted',
  'work-item.summarised',
  'work.returned',
  'hold.started',
  'hold.answered',
  'pull-request.merged',
  'work-item.closed',
] as const satisfies readonly (keyof Payloads)[];

/** Where a work item is, from its events. */
export interface WorkItemState {
  ticket: PayloadOf<'ticket.opened'> | undefined;
  spec: PayloadOf<'spec.written'> | undefined;
  /** The latest pull request pushed, and whether the coder must build again since. */
  pullRequest: PayloadOf<'pull-request.pushed'> | undefined;
  rebuild: { from: Stage; reason: string } | undefined;
  /** The coder's round: 1, and one more each time work returns to Build. */
  round: number;
  /** The gates on the latest push: the commit they started on, and how they ended, once they have. */
  gates: { commit: string; conclusion: 'passed' | 'failed' | undefined; failed: string[] } | undefined;
  /** Whether the gates have passed on the latest push: a later run on the same push (main merged in) is the console's. */
  gatesPassed: boolean;
  gateReturns: number;
  /** The review of the latest push, and how many reviews there have been. */
  review: PayloadOf<'review.submitted'> | undefined;
  reviews: number;
  /** Whether the describer has written up the approved change. */
  described: boolean;
  /** The hold in force, if any. */
  hold: PayloadOf<'hold.started'> | undefined;
  merged: boolean;
  closed: boolean;
}

export function fold(events: readonly LineEvent[]): WorkItemState {
  const state: WorkItemState = {
    ticket: undefined,
    spec: undefined,
    pullRequest: undefined,
    rebuild: undefined,
    round: 1,
    gates: undefined,
    gatesPassed: false,
    gateReturns: 0,
    review: undefined,
    reviews: 0,
    described: false,
    hold: undefined,
    merged: false,
    closed: false,
  };
  for (const event of events) {
    switch (event.type) {
      case 'ticket.opened':
        state.ticket = event.payload;
        break;
      case 'spec.written':
        state.spec = event.payload;
        break;
      case 'pull-request.pushed':
        state.pullRequest = event.payload;
        state.rebuild = undefined;
        state.gates = undefined;
        state.gatesPassed = false;
        state.review = undefined;
        break;
      case 'gates.started':
        if (!state.gatesPassed) state.gates = { commit: event.payload.commit, conclusion: undefined, failed: [] };
        break;
      case 'gates.finished':
        if (state.gates?.commit === event.payload.commit && !state.gatesPassed) {
          state.gates = { ...state.gates, conclusion: event.payload.conclusion, failed: event.payload.failed };
          state.gatesPassed = event.payload.conclusion === 'passed';
        }
        break;
      case 'review.submitted':
        state.review = event.payload;
        state.reviews += 1;
        break;
      case 'work-item.summarised':
        // Triage writes the first summary; the describer's follows an approving review.
        if (state.review?.verdict === 'approved') state.described = true;
        break;
      case 'work.returned':
        if (event.payload.to === 'build') {
          state.rebuild = { from: event.payload.from, reason: event.payload.reason };
          state.round += 1;
          if (event.payload.from === 'gates') state.gateReturns += 1;
        }
        break;
      case 'hold.started':
        state.hold = event.payload;
        break;
      case 'hold.answered':
        state.hold = undefined;
        break;
      case 'pull-request.merged':
        state.merged = true;
        break;
      case 'work-item.closed':
        state.closed = true;
        break;
    }
  }
  return state;
}

/** One thing to do next. */
export type Next =
  /** Open the ticket's issue in the app's repository, as the work item enters Plan. */
  | { do: 'open-issue' }
  /** Run an agent's step in a runner. A coder's later round resumes its own session. */
  | { do: 'step'; agent: LineAgent; round: number }
  /** Send the work back to an earlier stage. */
  | { do: 'return'; from: Stage; to: Stage; reason: string }
  /** Hold the work item for Martin. */
  | { do: 'hold'; hold: PayloadOf<'hold.started'> }
  /** Nothing to do until something outside the line happens. */
  | { do: 'wait'; for: 'gates' | 'martin' }
  /** The work item is over: merged, or closed. */
  | { do: 'finish' };

/** What the line knows of a work item beside its events: its issue, and how often its step in hand has failed. */
export interface Facts {
  issue: number | null;
  failures: number;
  /** Why the last attempt failed. */
  failure: string | null;
}

/** The stage a decision puts a work item in, as the line's table records it. */
export type QueueStage = 'plan' | 'build' | 'gates' | 'review' | 'held' | 'ended';

export interface Decision {
  stage: QueueStage;
  next: Next;
}

const STAGE_OF: Record<LineAgent, QueueStage> = {
  planner: 'plan',
  coder: 'build',
  reviewer: 'review',
  describer: 'review',
};

export function decide(events: readonly LineEvent[], facts: Facts): Decision {
  const s = fold(events);
  if (s.merged || s.closed) return { stage: 'ended', next: { do: 'finish' } };
  if (s.hold) return { stage: 'held', next: { do: 'wait', for: 'martin' } };

  const step = (agent: LineAgent): Decision => {
    const stage = STAGE_OF[agent];
    if (facts.failures >= LIMITS.failures) {
      const why = facts.failure ? `: ${facts.failure}` : '';
      return {
        stage: 'held',
        next: {
          do: 'hold',
          hold: {
            stage: stage as Stage,
            kind: 'held',
            reason: `The ${agent} failed ${facts.failures} times${why}`.slice(0, 300),
          },
        },
      };
    }
    return { stage, next: { do: 'step', agent, round: s.round } };
  };

  if (!s.spec) {
    if (facts.issue === null) return { stage: 'plan', next: { do: 'open-issue' } };
    return step('planner');
  }
  if (!s.pullRequest || s.rebuild) return step('coder');
  if (!s.gatesPassed) {
    if (s.gates?.conclusion !== 'failed') return { stage: 'gates', next: { do: 'wait', for: 'gates' } };
    const reason = `The gates failed: ${s.gates.failed.join(', ') || 'a check'}`.slice(0, 200);
    if (s.gateReturns >= LIMITS.gateReturns) {
      return { stage: 'held', next: { do: 'hold', hold: { stage: 'gates', kind: 'held', reason } } };
    }
    return { stage: 'build', next: { do: 'return', from: 'gates', to: 'build', reason } };
  }
  if (!s.review) return step('reviewer');
  switch (s.review.verdict) {
    case 'escalated':
      return {
        stage: 'held',
        next: { do: 'hold', hold: { stage: 'review', kind: 'held', reason: s.review.note.slice(0, 300) } },
      };
    case 'changes-requested': {
      const reason = `Review asked for changes: ${s.review.note}`.slice(0, 200);
      if (s.reviews >= LIMITS.reviews) {
        return { stage: 'held', next: { do: 'hold', hold: { stage: 'review', kind: 'held', reason } } };
      }
      return { stage: 'build', next: { do: 'return', from: 'review', to: 'build', reason } };
    }
    case 'approved':
      if (!s.described) return step('describer');
      return {
        stage: 'held',
        next: {
          do: 'hold',
          hold: {
            stage: 'review',
            kind: 'approval',
            reason: `The fix in pull request #${s.pullRequest.number} has passed its gates and review, and waits for Martin to merge it`,
          },
        },
      };
  }
}
