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
  /** Something the planner noticed outside its ticket, which triage judges as it judges a visitor's report. */
  'planner-finding',
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

/**
 * Where a signal comes from: one of the senses, or the planner, which leaves triage what it noticed outside its
 * ticket. A planner's finding is its own words about public code, so triage trusts it no more than a visitor's report.
 */
export const SIGNAL_SOURCES = [...SENSES, 'planner'] as const;
export type SignalSource = (typeof SIGNAL_SOURCES)[number];

/** Whether a signal came from one of the senses, not the planner. */
export const isSense = (source: SignalSource): source is Sense => source !== 'planner';

/** The agents, each with its own budget and model settings. Triage is a Jev question set and routing code. */
export const AGENTS = ['triage', 'planner', 'coder', 'reviewer', 'describer', 'red-team'] as const;
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

/** Who answers a model call: Anthropic's API, Amazon Bedrock, or a model running on Martin's Mac (LM Studio). */
export const MODEL_PROVIDERS = ['anthropic', 'bedrock', 'local'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Why a provider refused to answer, when it is a cap the factory does not own. */
export const PROVIDER_CAPS = ['credit', 'workspace-limit', 'unreachable'] as const;
export type ProviderCap = (typeof PROVIDER_CAPS)[number];

/**
 * Why a work item is held for Martin, so the line knows what his answer means (the line's `machine.ts` has a rule for
 * each). `unknown` is a hold that recorded no cause.
 */
export const HOLD_CAUSES = [
  /** Triage parked a suggestion, a visitor's or the planner's: only Martin asks for improvements. */
  'suggestion',
  /**
   * Triage parked a defect the planner noticed outside its ticket: the planner's word alone never opens a ticket, so
   * it waits for a sense to see it or for Martin.
   */
  'finding',
  /** A spec waits for Martin's approval before anything is built: an improvement's, or one tagged `out-of-scope`. */
  'spec',
  /** An agent asks Martin something only he can say. */
  'question',
  /** The planner judged the ticket one it cannot turn into a testable fix. */
  'ticket-rejected',
  /** The coder changed files outside the spec's scope. */
  'scope',
  /** The coder's first round found nothing to change: it says the code already does what the spec asks. */
  'nothing-to-fix',
  /** A step failed as often as the line allows. */
  'failures',
  /** The gates kept failing after the returns to the coder the line allows. */
  'gates',
  /** The reviewer escalated, or still asked for changes after the last review the line allows. */
  'review',
  /** The change passed its gates and review, and waits for Martin to merge it. */
  'merge',
  /** The work item has spent as much on models as one may: the gateway refuses its agents' calls. */
  'spend',
  /** The change's new tests pass without the fix (the tests-first check), so they prove nothing about it. */
  'tests-first',
  'unknown',
] as const;
export type HoldCause = (typeof HOLD_CAUSES)[number];

export const AUTONOMY = ['supervised', 'guarded', 'lights-out'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

/** Tags that route a change to a human, depending on autonomy (COMPONENTS.md, approval routing). */
export const RISKS = ['test-loosening', 'dependency-change', 'security-headers', 'out-of-scope'] as const;
export type Risk = (typeof RISKS)[number];

/**
 * Tags that hold a spec for Martin in every autonomy mode: a guardrail, not something the autonomy level decides. A
 * fix that changes behaviour beyond what its ticket is about needs a person, whatever the line is trusted with.
 */
export const ALWAYS_HELD: readonly Risk[] = ['out-of-scope'];

/** The only types an artifact may have. The console serves each with the type it was stored with, never a guess. */
export const ARTIFACT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/json'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** The most findings one review carries, so each reaches the events whole. */
export const MAX_FINDINGS = 20;
