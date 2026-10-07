/**
 * Every event type, and the version of its payload that is current. One type for each thing a stage does.
 *
 * Real events are stored at these versions, so a payload never changes in place: a change raises its type's version
 * here and adds an upcaster (upcast.ts), so that stored events and recordings keep reading as the current version.
 */
export const VERSIONS = {
  // A work item, from first event to last
  'work-item.opened': 1,
  'work-item.summarised': 1,
  'work-item.closed': 1,
  // Before the line: what a visitor started
  'defect.injected': 1,
  'attack.launched': 1,
  // Sense and triage
  'signal.received': 1,
  'judgement.made': 1,
  'ticket.opened': 1,
  // Plan and build
  'spec.written': 1,
  'pull-request.pushed': 2,
  // Gates and review
  'gates.started': 1,
  'gate.finished': 1,
  'gates.finished': 1,
  'review.submitted': 2,
  'pull-request.merged': 1,
  // Release and verify
  'release.started': 1,
  'canary.stepped': 1,
  'release.promoted': 1,
  'release.rolled-back': 1,
  'verification.finished': 1,
  // Anywhere on the line
  'work.returned': 2,
  'hold.started': 3,
  'hold.answered': 1,
  'action.refused': 2,
  'model.called': 2,
  // The line as a whole, with no work item
  'line.started': 1,
  'line.stopped': 1,
  'spend.capped': 2,
  'spend.cleared': 2,
} as const;

export type EventType = keyof typeof VERSIONS;

export const EVENT_TYPES = Object.keys(VERSIONS) as EventType[];

/** Types that belong to the line as a whole. Every other event belongs to a work item. */
export const LINE_TYPES: readonly EventType[] = ['line.started', 'line.stopped', 'spend.capped', 'spend.cleared'];

export const isEventType = (type: string): type is EventType => Object.hasOwn(VERSIONS, type);
