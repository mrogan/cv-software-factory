/**
 * The closed lists the events are written in. Plain values, so the browser can import them without Zod.
 */

/** The line, in order (TERMS.md). */
export const STAGES = ['sense', 'triage', 'plan', 'build', 'gates', 'review', 'release', 'verify'] as const;
export type Stage = (typeof STAGES)[number];

/** What a work item is (spec 5.2). */
export const KINDS = [
  'defect-fix',
  'injected-defect',
  'improvement',
  'dependency-update',
  'red-team',
  'visitor-report',
] as const;
export type Kind = (typeof KINDS)[number];

/** The defect categories of spec section 3.1. */
export const DEFECT_CATEGORIES = [
  'content',
  'navigation',
  'functional',
  'errors',
  'performance',
  'accessibility',
  'security',
  'observability',
] as const;
export type DefectCategory = (typeof DEFECT_CATEGORIES)[number];

/** A card's category: a defect's, or the kind of work when there is no defect. */
export const CATEGORIES = [...DEFECT_CATEGORIES, 'improvement', 'dependency', 'red-team', 'not-a-defect'] as const;
export type Category = (typeof CATEGORIES)[number];

/** How a defect shows itself from outside. Tickets and the answer key share these, so matching needs no judgement. */
export const SYMPTOM_CLASSES = [
  'broken-link',
  'broken-image',
  'redirect-loop',
  'wrong-result',
  'rejects-valid-input',
  'server-error',
  'browser-error',
  'slow-response',
  'not-cached',
  'missing-alt',
  'low-contrast',
  'unlabelled-field',
  'missing-header',
  'leaks-detail',
  'missing-log',
  'wrong-metric',
] as const;
export type SymptomClass = (typeof SYMPTOM_CLASSES)[number];

/** A ticket's severity: how badly the problem hurts a visitor. */
export const SEVERITIES = ['cosmetic', 'degraded', 'broken'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What triage's category question may answer for a report: a defect's category, or one of the two that are not. */
export const REPORT_CATEGORIES = [...DEFECT_CATEGORIES, 'suggestion', 'not-a-defect'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

/**
 * Where triage sends what it takes from the inbox: a new ticket, an open ticket it repeats, Martin (a suggestion),
 * quarantine (instructions aimed at the system), or nowhere (not a defect).
 */
export const TRIAGE_ROUTES = ['ticket', 'repeat', 'park', 'quarantine', 'discard'] as const;
export type TriageRoute = (typeof TRIAGE_ROUTES)[number];

/** The factory's five senses. */
export const SENSES = ['probe', 'crawler', 'metrics', 'logs', 'report'] as const;
export type Sense = (typeof SENSES)[number];

/** The agents, each with its own budget and model settings. Triage is a Jev question set and routing code. */
export const AGENTS = ['triage', 'planner', 'coder', 'reviewer', 'red-team'] as const;
export type Agent = (typeof AGENTS)[number];

/** Who did it. People, agents, and the systems around them. A visitor is never named: their key is a credential. */
export const ACTORS = [
  'martin',
  'visitor',
  ...AGENTS,
  ...SENSES.filter((sense) => sense !== 'report'),
  'widget',
  'injector',
  'actions',
  'rollouts',
  'dependabot',
  'factory',
] as const;
export type Actor = (typeof ACTORS)[number];

export const AUTONOMY = ['supervised', 'guarded', 'lights-out'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

/** Tags that route a change to a human, depending on autonomy (COMPONENTS.md, approval routing). */
export const RISKS = ['test-loosening', 'dependency-change', 'security-headers', 'out-of-scope'] as const;
export type Risk = (typeof RISKS)[number];

/** The only types an artifact may have. The console serves each with the type it was stored with, never a guess. */
export const ARTIFACT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/json'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];
