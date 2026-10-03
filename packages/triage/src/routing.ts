/**
 * Where a report goes, from Jev's answers and the policy: plain code, in a fixed order, so a reviewer can read,
 * test and tune it without retraining anything (TYPESAFE.md, "Routing").
 */
import type { DefectCategory, ReportCategory, Severity, SymptomClass } from '@software-factory/events';
import { REPORTS } from '../../../policy/triage.ts';

/** The answers routing reads, taken from Jev's typed answers. */
export interface ReportAnswers {
  category: ReportCategory;
  symptom: SymptomClass;
  /** Expected level on the severity rubric: 0 no harm, 1 cosmetic, 2 degraded, 3 broken. */
  severity: number;
  /** The probability that the report holds instructions aimed at the system. */
  injection: number;
  /** The open ticket it most likely repeats, if it was offered any, and how likely. */
  repeat?: { workItem: string | null; probability: number } | undefined;
}

export type Routed =
  | { route: 'quarantine' | 'park' | 'discard' }
  | { route: 'repeat'; joined: string }
  | { route: 'ticket'; category: DefectCategory; symptom: SymptomClass; severity: Severity };

export function routeReport(answers: ReportAnswers, policy = REPORTS): Routed {
  // Instructions first, whatever else the report is: it never reaches anything that acts on it.
  if (answers.injection >= policy.quarantine) return { route: 'quarantine' };
  if (answers.category === 'suggestion') return { route: 'park' };
  if (answers.category === 'not-a-defect') return { route: 'discard' };
  const { repeat } = answers;
  if (repeat?.workItem && repeat.probability >= policy.repeat) return { route: 'repeat', joined: repeat.workItem };
  return {
    route: 'ticket',
    category: answers.category,
    symptom: answers.symptom,
    severity: severityOf(answers.severity, policy),
  };
}

/** A problem report's severity. Below `degraded` it is cosmetic: a defect is never "no harm". */
export function severityOf(expected: number, policy = REPORTS): Severity {
  if (expected >= policy.severity.broken) return 'broken';
  if (expected >= policy.severity.degraded) return 'degraded';
  return 'cosmetic';
}
