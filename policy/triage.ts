/**
 * Triage's policy: how a sense's finding becomes a ticket, and the thresholds that route a report. Read by
 * `packages/triage`; the evaluation set (`make eval`) shows how far each threshold sits from the answers it
 * separates.
 */
import type { DefectCategory, Severity, SymptomClass } from '../packages/events/src/vocabulary.ts';

/**
 * A sense knows what it saw, so its ticket's category and severity follow from the symptom class. Severity is how
 * badly a visitor is hurt: cosmetic (they may not notice), degraded (it works, worse than it should), broken (they
 * cannot do what they came to do).
 */
export const SYMPTOMS: Record<SymptomClass, { category: DefectCategory; severity: Severity }> = {
  'broken-link': { category: 'navigation', severity: 'degraded' },
  'broken-image': { category: 'navigation', severity: 'cosmetic' },
  'redirect-loop': { category: 'navigation', severity: 'broken' },
  'wrong-result': { category: 'functional', severity: 'broken' },
  'rejects-valid-input': { category: 'functional', severity: 'broken' },
  'server-error': { category: 'errors', severity: 'broken' },
  'browser-error': { category: 'errors', severity: 'degraded' },
  'slow-response': { category: 'performance', severity: 'degraded' },
  'not-cached': { category: 'performance', severity: 'cosmetic' },
  'missing-alt': { category: 'accessibility', severity: 'degraded' },
  'low-contrast': { category: 'accessibility', severity: 'degraded' },
  'unlabelled-field': { category: 'accessibility', severity: 'degraded' },
  'missing-header': { category: 'security', severity: 'cosmetic' },
  'leaks-detail': { category: 'security', severity: 'degraded' },
  'missing-log': { category: 'observability', severity: 'degraded' },
  'wrong-metric': { category: 'observability', severity: 'cosmetic' },
};

/** The thresholds that route a report, applied in this order (TYPESAFE.md, "Routing"). */
export const REPORTS = {
  /** At or above this probability that a report holds instructions aimed at the system, it is quarantined. */
  quarantine: 0.5,
  /** At or above this probability that a report repeats an open ticket, it joins that ticket. */
  repeat: 0.6,
  /**
   * Severity is Jev's expected level on the rubric (0 no harm, 1 cosmetic, 2 degraded, 3 broken). A problem report
   * below `degraded` is cosmetic, and from `broken` up it is broken.
   */
  severity: { degraded: 1.5, broken: 2.5 },
} as const;

/** How triage takes signals from the inbox. */
export const INBOX = {
  /** Tries before a signal is left in the inbox with its reason, for a person to look at. */
  attempts: 5,
  /** How long a taken signal is held before another worker may try it, in seconds. */
  leaseSeconds: 120,
} as const;
