/**
 * Each work item's state at a time t, folded from its events. Everything else the console shows is derived from
 * these states and the events behind them.
 */
import type { Category, Evidence, Kind, PayloadOf, PublicEvent, Screenshot, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';

export type Outcome = 'verified' | 'rolled-back' | 'closed' | 'held' | 'needs-you' | 'in-progress';

export interface Hold {
  stage: Stage;
  kind: 'approval' | 'question' | 'held';
  reason: string;
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
    case 'pull-request.merged':
      return 'review';
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
      return { planner: 'plan', coder: 'build', reviewer: 'review', 'red-team': 'build', triage: 'triage' }[
        event.payload.agent
      ] as Stage;
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
  };
  let triageClosed = false;

  for (const event of events) {
    const time = at(event);
    state.lastAt = time;
    const stage = stageOf(event);
    if (stage) {
      if (!state.entry) state.entry = stage;
      if (stage !== state.stage) {
        const previous = state.stage;
        // Moving on is leaving a stage behind, done. Being sent back is not: the sender has not passed it.
        const forward = previous && STAGES.indexOf(stage) > STAGES.indexOf(previous);
        if (previous && forward && state.visits[previous]) {
          state.visits[previous] = { ...state.visits[previous], leftAt: time };
        }
        state.visits[stage] = { enteredAt: time, leftAt: undefined };
        state.stage = stage;
      }
      state.latest[stage] = event;
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
        if (!state.description) state.title = event.payload.title;
        break;
      case 'judgement.made':
        triageClosed = event.payload.route === 'discard';
        break;
      case 'defect.injected':
        state.versions.from = event.payload.version;
        state.versions.live = true;
        break;
      case 'signal.received':
        state.evidence.signal ??= event.payload.evidence;
        break;
      case 'pull-request.pushed':
        state.pullRequest = event.payload.number;
        break;
      case 'hold.started':
        state.hold = {
          stage: event.payload.stage,
          kind: event.payload.kind,
          reason: event.payload.reason,
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
        break;
      case 'work-item.closed':
        state.closedAt = time;
        state.hold = undefined;
        state.outcome =
          event.payload.outcome === 'verified'
            ? 'verified'
            : event.payload.outcome === 'rolled-back'
              ? 'rolled-back'
              : 'closed';
        if (state.stage) state.visits[state.stage] = { ...(state.visits[state.stage] as Visit), leftAt: time };
        if (event.payload.outcome === 'no-change' && triageClosed) state.category = 'not-a-defect';
        break;
    }
    if (event.type === 'judgement.made') state.spend += event.payload.costUsd;

    event.artifacts.forEach((shot, index) => {
      const side = shot.kind === 'screenshot' ? sideOf(event, state.kind, index) : undefined;
      if (shot.kind === 'screenshot' && side) state.captures.push({ shot, at: time, side });
    });
  }

  if (!state.closedAt) {
    state.outcome = state.hold ? (state.hold.kind === 'held' ? 'held' : 'needs-you') : 'in-progress';
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
