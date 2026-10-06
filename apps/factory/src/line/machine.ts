/**
 * What the line does next with a work item, decided from its events alone. A pure function, so a test drives it with
 * a list of events, and a line that stopped or crashed carries on from the last event it appended: nothing about a
 * work item's progress lives anywhere else.
 *
 *     ticket → [issue] → planner → spec → coder → pull request → gates → reviewer → describer → Martin's merge
 *                                            ▲                      │          │
 *                                            └──── work returned ───┴──────────┘
 *
 * The coder's patch passes the scope fence before it reaches GitHub. One the fence refuses goes back to the coder
 * once, with the fence's output, and stays in Build; a second refusal holds the work item for Martin. A scope the
 * coder keeps straying from is the planner's to fix, so his answer sends the work item back to Plan, and the planner
 * is told what the fence printed and what he said.
 *
 * The events are folded into where the work item is (`fold`), and `decide` turns that into one next action. Each
 * action either appends events, which moves the work item on, or waits for something outside the line: the gates
 * (GitHub's checks, which the line reads and appends as events) or Martin. The bounds a step has (its turns and
 * deadline) are each agent's (`agents/`); the bounds on the loop are `LIMITS`.
 *
 * A hold waits for Martin's answer, and what the answer does depends on why the work item is held: `ANSWERS` has a
 * rule for each cause and each answer.
 */
import { type HoldCause, type PayloadOf, STAGES, type Stage } from '@software-factory/events';

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
  /** Tries at a handback's effects, when GitHub or the store fails, before the work item holds. */
  effects: 6,
  /**
   * Patches the scope fence refuses before the work item holds: the first goes back to the coder with the fence's
   * output, and the second holds. Martin's answer to the hold starts the count again.
   */
  fenceRefusals: 2,
} as const;

type Answer = PayloadOf<'hold.answered'>['decision'];

/** What Martin's answer to a hold does to the work item. */
export type Resolution =
  /** It carries on from where it was held: the step it was held at runs again, with his answer. */
  | 'carry-on'
  /** The planner writes the spec again, with his answer. */
  | 'replan'
  /** His approval stands in for the reviewer's, and the change goes on to its description and his merge. */
  | 'approve'
  /** The work goes back to the coder, with his answer as the reason. */
  | 'return'
  /** Nothing for the line to do: it waits for him, as for his merge. */
  | 'wait'
  /** The work item closes unmerged. */
  | 'close';

/**
 * What each answer does, for each cause of a hold. Rejecting closes the work item, whatever the cause. Where the
 * planner rejected the ticket, approving agrees with it and closes the work item too; only an answer, which tells the
 * planner what it missed, sends the ticket back to it. Where the fence kept refusing the coder's patch, approving
 * says the coder needed those files and answering says what to do instead: either way the planner writes the spec
 * again, told both.
 */
export const ANSWERS: Record<HoldCause, Record<Answer, Resolution>> = {
  // Triage's: a suggestion never comes onto the line.
  suggestion: { approved: 'wait', rejected: 'close', answered: 'wait' },
  spec: { approved: 'carry-on', rejected: 'close', answered: 'replan' },
  question: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  'ticket-rejected': { approved: 'close', rejected: 'close', answered: 'carry-on' },
  scope: { approved: 'replan', rejected: 'close', answered: 'replan' },
  failures: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
  gates: { approved: 'return', rejected: 'close', answered: 'return' },
  review: { approved: 'approve', rejected: 'close', answered: 'return' },
  merge: { approved: 'wait', rejected: 'close', answered: 'return' },
  unknown: { approved: 'carry-on', rejected: 'close', answered: 'carry-on' },
};

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
    | 'action.refused'
    | 'pull-request.merged'
    | 'work-item.closed']: PayloadOf<K>;
};

/** Where a work item is, from its events. */
export interface WorkItemState {
  ticket: PayloadOf<'ticket.opened'> | undefined;
  spec: PayloadOf<'spec.written'> | undefined;
  /** The latest pull request pushed, and whether the coder must build again since. */
  pullRequest: PayloadOf<'pull-request.pushed'> | undefined;
  rebuild: { from: Stage; reason: string } | undefined;
  /** The coder's round: 1, and one more each time work returns to Build. */
  round: number;
  /** The scope fence's output on the coder's last patch, when it refused that patch and nothing was pushed since. */
  fenced: string | undefined;
  /** The coder's patches the scope fence has refused, since Martin last answered a hold. */
  fenceRefusals: number;
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
  /** Martin's answer to the last hold, until the work item moves on from it: what it does, and what he said. */
  answer:
    | { cause: HoldCause; stage: Stage; decision: Answer; resolution: Resolution; text: string | undefined }
    | undefined;
  /**
   * Martin's answers to the holds at Plan, and to those that send the work item back to it, each with what he was
   * asked (the planner's question, why it was held, or what the scope fence printed), for every later step of the
   * planner's: a second question should not forget the first answer.
   */
  answers: { asked: string; answer: string }[];
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
    fenced: undefined,
    fenceRefusals: 0,
    gates: undefined,
    gatesPassed: false,
    gateReturns: 0,
    review: undefined,
    reviews: 0,
    described: false,
    hold: undefined,
    answer: undefined,
    answers: [],
    merged: false,
    closed: false,
  };
  for (const event of events) {
    // Anything that moves the work item on is past the answer that moved it.
    if (MOVES_ON.has(event.type)) state.answer = undefined;
    switch (event.type) {
      case 'ticket.opened':
        state.ticket = event.payload;
        break;
      case 'spec.written':
        state.spec = event.payload;
        // A new spec is a new scope: what the fence refused under the last one is no part of it.
        state.fenced = undefined;
        break;
      case 'pull-request.pushed':
        state.pullRequest = event.payload;
        state.rebuild = undefined;
        state.fenced = undefined;
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
      case 'hold.answered': {
        if (!state.hold) break;
        const { cause, stage } = state.hold;
        const resolution = ANSWERS[cause][event.payload.decision];
        state.answer = { cause, stage, decision: event.payload.decision, resolution, text: event.payload.answer };
        const said =
          event.payload.answer ??
          (cause === 'scope' && event.payload.decision === 'approved' ? FENCE_APPROVED : undefined);
        if ((stage === 'plan' || resolution === 'replan') && said) {
          state.answers.push({ asked: askedOf(state.hold, state.fenced), answer: said });
        }
        state.hold = undefined;
        state.fenceRefusals = 0;
        if (resolution === 'replan') state.spec = undefined;
        if (resolution === 'approve' && state.review) state.review = { ...state.review, verdict: 'approved' };
        break;
      }
      case 'action.refused':
        if (event.payload.mechanism === 'scope-fence') {
          state.fenced = event.payload.output;
          state.fenceRefusals += 1;
        }
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

/** What approving a hold of the scope fence's says, for the planner. */
const FENCE_APPROVED = 'Yes: the coder needed those files, so let the scope take them in.';

/** What Martin was asked by a hold, as the planner is told it. */
function askedOf(hold: PayloadOf<'hold.started'>, fenced: string | undefined): string {
  if (hold.cause === 'scope' && fenced)
    return `${hold.reason}. The scope fence printed: ${fenced.split('\n').join('; ')}.`;
  return hold.question ?? hold.reason;
}

const MOVES_ON = new Set<LineEvent['type']>([
  'spec.written',
  'pull-request.pushed',
  'review.submitted',
  'work-item.summarised',
  'work.returned',
  'hold.started',
]);

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
  /** Close the work item unmerged, as Martin answered. */
  | { do: 'close'; reason: string }
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

/** The stage each agent works in. */
export const STAGE_OF: Record<LineAgent, 'plan' | 'build' | 'review'> = {
  planner: 'plan',
  coder: 'build',
  reviewer: 'review',
  describer: 'review',
};

export function decide(events: readonly LineEvent[], facts: Facts): Decision {
  const s = fold(events);
  if (s.merged || s.closed) return { stage: 'ended', next: { do: 'finish' } };
  if (s.hold) return { stage: 'held', next: { do: 'wait', for: 'martin' } };
  const answered = s.answer && afterAnswer(s.answer);
  if (answered) return answered;

  const step = (agent: LineAgent): Decision => {
    const stage = STAGE_OF[agent];
    if (facts.failures >= LIMITS.failures) {
      const why = facts.failure ? `: ${facts.failure}` : '';
      return {
        stage: 'held',
        next: {
          do: 'hold',
          hold: {
            stage,
            kind: 'held',
            cause: 'failures',
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
  if (!s.pullRequest || s.rebuild) {
    if (s.fenceRefusals >= LIMITS.fenceRefusals) {
      const reason = `The scope fence refused the coder’s patch ${s.fenceRefusals} times: it changed files outside the spec’s scope`;
      return {
        stage: 'held',
        next: { do: 'hold', hold: { stage: 'build', kind: 'held', cause: 'scope', reason } },
      };
    }
    return step('coder');
  }
  if (!s.gatesPassed) {
    if (s.gates?.conclusion !== 'failed') return { stage: 'gates', next: { do: 'wait', for: 'gates' } };
    const reason = `The gates failed: ${s.gates.failed.join(', ') || 'a check'}`.slice(0, 200);
    if (s.gateReturns >= LIMITS.gateReturns) {
      return { stage: 'held', next: { do: 'hold', hold: { stage: 'gates', kind: 'held', cause: 'gates', reason } } };
    }
    return { stage: 'build', next: { do: 'return', from: 'gates', to: 'build', reason } };
  }
  if (!s.review) return step('reviewer');
  switch (s.review.verdict) {
    case 'escalated':
      return {
        stage: 'held',
        next: {
          do: 'hold',
          hold: { stage: 'review', kind: 'held', cause: 'review', reason: s.review.note.slice(0, 300) },
        },
      };
    case 'changes-requested': {
      const reason = `Review asked for changes: ${s.review.note}`.slice(0, 200);
      if (s.reviews >= LIMITS.reviews) {
        return {
          stage: 'held',
          next: { do: 'hold', hold: { stage: 'review', kind: 'held', cause: 'review', reason } },
        };
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
            cause: 'merge',
            reason: `The fix in pull request #${s.pullRequest.number} has passed its gates and review, and waits for Martin to merge it`,
          },
        },
      };
  }
}

/** What the line does straight after Martin's answer, or undefined to carry on as the work item's events say. */
function afterAnswer(answer: NonNullable<WorkItemState['answer']>): Decision | undefined {
  const said = answer.text ? `: ${answer.text}` : '';
  switch (answer.resolution) {
    case 'close': {
      // Approving closes only a planner's rejection: he agrees with the planner.
      const why = answer.decision === 'approved' ? 'Martin agreed with the planner' : 'Martin rejected it';
      return { stage: 'held', next: { do: 'close', reason: `${why}${said}`.slice(0, 200) } };
    }
    case 'wait':
      return { stage: 'held', next: { do: 'wait', for: 'martin' } };
    case 'return':
      // Only from a stage after Build; the rules never ask for more.
      if (STAGES.indexOf(answer.stage) <= STAGES.indexOf('build')) return undefined;
      return {
        stage: 'build',
        next: { do: 'return', from: answer.stage, to: 'build', reason: `Martin sent it back${said}`.slice(0, 200) },
      };
    default:
      return undefined;
  }
}
