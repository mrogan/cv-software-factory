/**
 * Every event type, and the version of its payload that is current. One type for each thing a stage does.
 *
 * Real events are stored at these versions, so a payload never changes in place: a change raises its type's version
 * here and adds an upcaster (upcast.ts), so that stored events and recordings keep reading as the current version.
 */
export const VERSIONS = {
  // A work item, from first event to last
  'work-item.opened': 2,
  'work-item.summarised': 1,
  'work-item.closed': 1,
  'work-item.reopened': 3,
  // Before the line: what a visitor started
  'defect.injected': 1,
  'attack.launched': 1,
  // Sense and triage
  'signal.received': 4,
  'judgement.made': 1,
  'ticket.opened': 1,
  // Plan and build
  'spec.written': 3,
  'pull-request.pushed': 2,
  'suggestions.answered': 1,
  'wait.started': 1,
  // Gates and review
  'gates.started': 1,
  'gate.finished': 1,
  'gates.finished': 1,
  'review.submitted': 4,
  'pull-request.merged': 1,
  // Release and verify
  'release.started': 3,
  'canary.stepped': 2,
  'release.promoted': 2,
  'release.rolled-back': 3,
  'release.aborted': 1,
  'release.errored': 1,
  'verification.finished': 4,
  'signal.rechecked': 1,
  // Anywhere on the line
  'work.returned': 3,
  'hold.started': 8,
  'hold.answered': 2,
  'action.refused': 2,
  'model.called': 2,
  // The line as a whole, with no work item
  'line.started': 2,
  'line.stopped': 1,
  'spend.capped': 2,
  'spend.cleared': 2,
  'score.updated': 1,
  // Martin signing in and out, and his passkeys (the admin service, and `factory admin enrol`)
  'admin.signed-in': 1,
  'admin.signed-out': 1,
  'admin.stepped-up': 1,
  'passkey.enrolled': 1,
  'passkey.revoked': 1,
  // Martin's controls of a release in flight (the admin service)
  'release.controlled': 2,
  // Martin's settings: each agent's model and effort, and the spend caps (the admin service)
  'settings.changed': 1,
} as const;

export type EventType = keyof typeof VERSIONS;

export const EVENT_TYPES = Object.keys(VERSIONS) as EventType[];

/** Types that belong to the line as a whole. */
export const LINE_TYPES: readonly EventType[] = [
  'line.started',
  'line.stopped',
  'spend.capped',
  'spend.cleared',
  'score.updated',
  'admin.signed-in',
  'admin.signed-out',
  'admin.stepped-up',
  'passkey.enrolled',
  'passkey.revoked',
  'release.controlled',
  'settings.changed',
];

/**
 * Types that belong to a work item or to the line. A release's events are on each work item it carries, and on the
 * line when it carries none. Every other event belongs to a work item.
 */
export const RELEASE_TYPES: readonly EventType[] = [
  'release.started',
  'canary.stepped',
  'release.promoted',
  'release.rolled-back',
  'release.aborted',
  'release.errored',
];

/**
 * Martin's commands: the types only his roles may append (row security on `events`, `0023_martins-commands.sql`), and
 * that the line, triage and the gateway act on only when one of his roles appended it. Signing in and out, giving his
 * passkey again, and his passkeys are among them, so no worker can forge one (`0025_admin-service.sql`,
 * `0026_admin-stepped-up.sql`), and so are his controls of a release (`release.controlled`,
 * `0027_release-controls.sql`), and his settings (`settings.changed`, `0028_settings.sql`). Each of the admin
 * service's commands still to come (autonomy, the switches) joins this list when its type joins the catalogue, and a
 * migration adds it to the store's own list (`admin_event`): the store's tests fail until the two agree. `release.aborted` is not one: it is the line's record of
 * what the Rollout did, and says `by: martin` when his control came first.
 */
export const ADMIN_TYPES: readonly EventType[] = [
  'hold.answered',
  'line.started',
  'line.stopped',
  'admin.signed-in',
  'admin.signed-out',
  'admin.stepped-up',
  'passkey.enrolled',
  'passkey.revoked',
  'release.controlled',
  'settings.changed',
];

export const isEventType = (type: string): type is EventType => Object.hasOwn(VERSIONS, type);
