/**
 * Each work item's state at a time t, folded from its events. Everything else the console shows is derived from
 * these states and the events behind them.
 */
import type {
  Category,
  Evidence,
  HoldCause,
  Kind,
  PayloadOf,
  PublicEvent,
  Screenshot,
  Stage,
} from '@software-factory/events';
import { STAGES } from '@software-factory/events';

/**
 * How a work item stands. Besides the line's own: `waiting`, a ticket queued for the planner, with nothing being
 * done to it yet; `merged`, a fix Martin merged, queued at Release for a release to take it; `quarantined`, a report
 * that gave orders to the system; `no-ticket`, a report that described nothing wrong.
 */
export type Outcome =
  | 'verified'
  | 'rolled-back'
  | 'closed'
  | 'quarantined'
  | 'no-ticket'
  | 'held'
  | 'needs-you'
  | 'waiting'
  | 'merged'
  | 'in-progress';

export interface Hold {
  stage: Stage;
  kind: 'approval' | 'question' | 'held';
  /** Why the line holds it, which decides the picture the card draws for it. */
  cause: HoldCause;
  reason: string;
  /** A spend hold's cap. */
  limitUsd: number | undefined;
  question: string | undefined;
  since: number;
}

export interface Visit {
  /** When the item last came into the stage. */
  enteredAt: number;
  /** When it last left the stage for a later one, or closed in it, if it has. Not set by being sent back. */
  leftAt: number | undefined;
}

/** A screenshot, and what it shows in the item's story. */
export interface Capture {
  shot: Screenshot;
  at: number;
  /**
   * before: the app before the change; broken: the problem; fixed or after: the change, live; canary: on the
   * canary; page: the page a visitor reported on.
   */
  side: 'before' | 'broken' | 'fixed' | 'after' | 'canary' | 'page';
}

export interface ItemState {
  number: string;
  kind: Kind;
  sample: boolean;
  openedBy: PublicEvent['actor'];
  openedAt: number;
  /** The last event's time, at or before t. */
  lastAt: number;
  title: string;
  description: string | undefined;
  story: string | undefined;
  category: Category;
  /** Every event of the item at or before t, in order. */
  events: PublicEvent[];
  /** The stage the item is in, or was in when it closed. Null before it reaches the line. */
  stage: Stage | null;
  /** The first stage it reached: stages before it were skipped. */
  entry: Stage | null;
  visits: Partial<Record<Stage, Visit>>;
  hold: Hold | undefined;
  outcome: Outcome;
  closedAt: number | undefined;
  /** A failure that nothing has followed yet: no retry, return, hold or close. */
  failure: { stage: Stage; at: number } | undefined;
  /** The last thing that happened in each stage, for the stage panels. */
  latest: Partial<Record<Stage, PublicEvent>>;
  dependency: PayloadOf<'work-item.opened'>['dependency'];
  pullRequest: number | undefined;
  /** Versions: the one it broke (an injection) or replaced, the one it shipped, and whether that was rolled back. */
  versions: { from: string | undefined; to: string | undefined; rolledBack: boolean; live: boolean };
  /** A release still on its canary, at this share of traffic. */
  canary: { version: string; weight: number } | undefined;
  captures: Capture[];
  evidence: { signal: Evidence | undefined; verified: Evidence | undefined };
  spend: number;
  /**
   * Agents' steps that called a model, and Jev's judgements, so that none at all can be said as such. A step is one
   * `model.called` however many calls it made: the sheet counts the calls.
   */
  calls: number;
  /** The ticket triage opened, if it has. */
  ticket: PayloadOf<'ticket.opened'> | undefined;
  /**
   * Work queued at a stage that has not taken it: a ticket waiting for the planner, its last step the ticket; or a
   * merged fix waiting for a release, its last step the merge.
   */
  queued: boolean;
  /** The app's version when a sense first saw the problem. */
  seenOn: string | undefined;
  /** The page a visitor's report came from, at its path only. */
  reportPage: string | undefined;
}

/** The stage an event moves its item to, if any. */
export function stageOf(event: PublicEvent): Stage | null {
  switch (event.type) {
    case 'signal.received':
      return 'sense';
    case 'judgement.made':
    case 'ticket.opened':
      return 'triage';
    case 'spec.written':
      return 'plan';
    case 'pull-request.pushed':
      // Dependabot's pull requests are built outside the factory: they reach the line at Gates.
      return event.actor === 'dependabot' ? null : 'build';
    case 'gates.started':
    case 'gate.finished':
    case 'gates.finished':
      return 'gates';
    case 'review.submitted':
      return 'review';
    // A merge leaves Review: the fix waits at Release for a release to take it.
    case 'pull-request.merged':
      return 'release';
    case 'release.started':
    case 'canary.stepped':
    case 'release.promoted':
    case 'release.rolled-back':
      return 'release';
    case 'verification.finished':
      return 'verify';
    case 'work.returned':
      return event.payload.to;
    case 'hold.started':
      return event.payload.stage;
    case 'action.refused':
      return event.payload.mechanism === 'admission-control' ? 'release' : 'build';
    case 'model.called':
      return {
        planner: 'plan',
        coder: 'build',
        reviewer: 'review',
        describer: 'review',
        'red-team': 'build',
        triage: 'triage',
      }[event.payload.agent] as Stage;
    default:
      return null;
  }
}

const isFailure = (event: PublicEvent) =>
  (event.type === 'gates.finished' && event.payload.conclusion === 'failed') ||
  event.type === 'action.refused' ||
  event.type === 'release.rolled-back';

const DEFAULT_CATEGORY: Record<Kind, Category> = {
  'defect-fix': 'functional',
  'injected-defect': 'functional',
  improvement: 'improvement',
  'dependency-update': 'dependency',
  'red-team': 'red-team',
  'visitor-report': 'not-a-defect',
  'planner-finding': 'improvement',
};

/** The outcome each way of closing gives. */
const CLOSED: Record<PayloadOf<'work-item.closed'>['outcome'], Outcome> = {
  verified: 'verified',
  'rolled-back': 'rolled-back',
  'no-change': 'closed',
  quarantined: 'quarantined',
  discarded: 'no-ticket',
};

/** Folds one work item's events (all at or before t, in order) into its state. */
export function foldItem(events: readonly PublicEvent[]): ItemState | undefined {
  const opened = events.find((event): event is PublicEvent<'work-item.opened'> => event.type === 'work-item.opened');
  if (!opened?.work_item) return undefined;
  const at = (event: PublicEvent) => Date.parse(event.ts);
  const state: ItemState = {
    number: opened.work_item,
    kind: opened.payload.kind,
    sample: opened.payload.sample,
    openedBy: opened.actor,
    openedAt: at(opened),
    lastAt: at(opened),
    title: opened.payload.title,
    description: undefined,
    story: undefined,
    category: opened.payload.category ?? DEFAULT_CATEGORY[opened.payload.kind],
    events: [...events],
    stage: null,
    entry: null,
    visits: {},
    hold: undefined,
    outcome: 'in-progress',
    closedAt: undefined,
    failure: undefined,
    latest: {},
    dependency: opened.payload.dependency,
    pullRequest: undefined,
    versions: { from: undefined, to: undefined, rolledBack: false, live: false },
    canary: undefined,
    captures: [],
    evidence: { signal: undefined, verified: undefined },
    spend: 0,
    calls: 0,
    ticket: undefined,
    queued: false,
    seenOn: undefined,
    reportPage: undefined,
  };
  /** Moves the item into a stage: leaving the one it was in, if this is further along the line. */
  const enter = (stage: Stage, time: number) => {
    if (!state.entry) state.entry = stage;
    if (stage === state.stage) return;
    const previous = state.stage;
    // Moving on is leaving a stage behind, done. Being sent back is not: the sender has not passed it.
    const forward = previous && STAGES.indexOf(stage) > STAGES.indexOf(previous);
    if (previous && forward && state.visits[previous]) {
      state.visits[previous] = { ...state.visits[previous], leftAt: time };
    }
    state.visits[stage] = { enteredAt: time, leftAt: undefined };
    state.stage = stage;
  };
  for (const event of events) {
    const time = at(event);
    state.lastAt = time;
    // Once there is a ticket, another sense's signal or a report that repeats it adds evidence: it does not take
    // the ticket back up the line.
    const joining = state.ticket && (event.type === 'signal.received' || event.type === 'judgement.made');
    const stage = joining ? null : stageOf(event);
    if (stage) {
      enter(stage, time);
      state.latest[stage] = event;
      state.queued = false;
      if (event.type !== 'model.called') state.failure = isFailure(event) ? { stage, at: time } : undefined;
    }

    switch (event.type) {
      case 'work-item.summarised':
        state.title = event.payload.title;
        state.description = event.payload.description;
        state.story = event.payload.story;
        break;
      case 'ticket.opened':
        state.category = event.payload.category;
        state.ticket = event.payload;
        if (!state.description) state.title = event.payload.title;
        // A ticket has left Triage: it sits at Plan, waiting for the planner, until something happens there.
        enter('plan', time);
        state.latest.plan = event;
        state.queued = true;
        break;
      case 'defect.injected':
        state.versions.from = event.payload.version;
        state.versions.live = true;
        break;
      case 'signal.received':
        state.evidence.signal ??= event.payload.evidence?.[0];
        state.seenOn ??= event.payload.version;
        if (event.payload.report) state.reportPage ??= event.payload.report.page;
        break;
      case 'pull-request.pushed':
        state.pullRequest = event.payload.number;
        break;
      case 'pull-request.merged':
        // The merge is Martin's answer to a wait for it: the line writes no other.
        state.hold = undefined;
        state.queued = true;
        break;
      case 'hold.started':
        state.hold = {
          stage: event.payload.stage,
          kind: event.payload.kind,
          cause: event.payload.cause,
          reason: event.payload.reason,
          limitUsd: event.payload.limitUsd,
          question: event.payload.question,
          since: time,
        };
        break;
      case 'hold.answered':
        state.hold = undefined;
        break;
      case 'release.started':
        state.versions.from ??= event.payload.previous;
        state.versions.to = event.payload.version;
        state.canary = { version: event.payload.version, weight: 0 };
        break;
      case 'canary.stepped':
        state.canary = { version: event.payload.version, weight: event.payload.weight };
        break;
      case 'release.promoted':
        state.canary = undefined;
        state.versions.live = true;
        break;
      case 'release.rolled-back':
        state.canary = undefined;
        state.versions.rolledBack = true;
        break;
      case 'verification.finished':
        state.evidence.verified = event.payload.evidence;
        break;
      case 'model.called':
        state.spend += event.payload.costUsd;
        state.calls += 1;
        break;
      case 'work-item.closed':
        state.closedAt = time;
        state.hold = undefined;
        state.queued = false;
        state.outcome = CLOSED[event.payload.outcome];
        if (state.stage) state.visits[state.stage] = { ...(state.visits[state.stage] as Visit), leftAt: time };
        if (event.payload.outcome === 'discarded') state.category = 'not-a-defect';
        break;
    }
    if (event.type === 'judgement.made') {
      state.spend += event.payload.costUsd;
      state.calls += 1;
    }

    event.artifacts.forEach((shot, index) => {
      const side = shot.kind === 'screenshot' ? sideOf(event, state.kind, index) : undefined;
      if (shot.kind === 'screenshot' && side) state.captures.push({ shot, at: time, side });
    });
  }

  if (!state.closedAt) {
    if (state.hold) state.outcome = state.hold.kind === 'held' ? 'held' : 'needs-you';
    else if (state.queued) state.outcome = state.stage === 'release' ? 'merged' : 'waiting';
    else state.outcome = 'in-progress';
  }
  return state;
}

/** What a screenshot attached to an event shows, in the item's story. Pages compared at verify are not sides. */
function sideOf(event: PublicEvent, kind: Kind, index: number): Capture['side'] | undefined {
  switch (event.type) {
    case 'defect.injected':
    case 'spec.written':
      return 'before';
    case 'signal.received':
      return kind === 'visitor-report' ? 'page' : 'broken';
    case 'canary.stepped':
      return 'canary';
    case 'verification.finished': {
      // A marked screenshot comes first, when there is one; the rest are the pages compared.
      const first = event.artifacts[0];
      if (index > 0 || first?.kind !== 'screenshot' || !first.boxes.length) return undefined;
      return kind === 'improvement' ? 'after' : 'fixed';
    }
    default:
      return undefined;
  }
}

/** Groups events by work item, keeping their order, and folds each. Events with no work item are left out. */
export function foldItems(events: readonly PublicEvent[]): ItemState[] {
  const byItem = new Map<string, PublicEvent[]>();
  for (const event of events) {
    if (!event.work_item) continue;
    const list = byItem.get(event.work_item);
    if (list) list.push(event);
    else byItem.set(event.work_item, [event]);
  }
  return [...byItem.values()].flatMap((list) => foldItem(list) ?? []).sort((a, b) => a.openedAt - b.openedAt);
}
