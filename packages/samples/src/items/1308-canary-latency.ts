/**
 * A rollback is a signal: the canary's ticket. v0.9.9, a release of Martin's own commits, rolled back three minutes
 * into its 25% step, and the line left triage the measure that failed. Prometheus had nothing from the canary, so
 * the signal carries no series and no routes, only the measure; the ticket waits for the planner. That evening a build
 * of one of Martin's commits rolled back the same way, and its signal joined the ticket.
 */
import { Item, releaseFor } from '../build.ts';
import { EVENING, V099_LATENCY } from './line.ts';

export default new Item('1308', '2026-10-05T11:23:40+01:00')
  .at('0:00', 'work-item.opened', 'triage', 'The canary opened a work item', {
    kind: 'defect-fix',
    title: 'Slow responses in a canary release',
    sample: true,
    category: 'performance',
  })
  .at('0:00', 'signal.received', 'canary', `v0.9.9 did worse than v0.9.8 on latency: ${V099_LATENCY.message}`, {
    sense: 'canary',
    check: 'latency',
    route: '*',
    version: 'v0.9.9',
    symptom: 'slow-response',
    evidence: [
      { kind: 'canary', release: releaseFor('v0.9.9'), version: 'v0.9.9', against: 'v0.9.8', measure: V099_LATENCY },
    ],
  })
  .at('0:00', 'ticket.opened', 'triage', 'Ticket #1308: performance, degraded', {
    title: 'Slow responses in a canary release',
    category: 'performance',
    severity: 'degraded',
    fingerprint: { route: '*', class: 'slow-response' },
    traces: [],
  })
  .at('0:00', 'work-item.summarised', 'triage', 'Summary written', {
    title: 'Slow responses in a canary release',
    description:
      'The canary found it: latency. v0.9.9 rolled back at 25% before a step was measured. Triage opened a ticket.',
    story:
      'v0.9.9 carried none of the factory’s work: it was Martin’s own commits. Three minutes into its 25% step, the canary’s latency failed its second look against v0.9.8, and Argo Rollouts sent all the traffic back. Prometheus had no requests from the canary to compare, so the analysis kept no series and could name no route. A rollback is a signal: the line left triage the failed measure, and triage opened this ticket with it.',
  })
  .at(
    '7:20:00',
    'signal.received',
    'canary',
    `${EVENING.slice(0, 7)} did worse than v0.9.10 on latency: ${V099_LATENCY.message}`,
    {
      sense: 'canary',
      check: 'latency',
      route: '*',
      version: EVENING,
      symptom: 'slow-response',
      evidence: [
        { kind: 'canary', release: releaseFor(EVENING), version: EVENING, against: 'v0.9.10', measure: V099_LATENCY },
      ],
    },
  );
