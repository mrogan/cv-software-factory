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

/**
 * What the senses read besides the app, which triage looks at before it trusts a sense's new problem: Prometheus, Loki
 * and Tempo, and the disk under the cluster's volumes.
 */
export const DEPENDENCIES = ['prometheus', 'loki', 'tempo', 'disk'] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

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

/**
 * The factory's senses. Five watch the stable version; the canary is the release's analysis, which sees a new version
 * do worse than the one it would replace, and says so when it rolls it back.
 */
export const SENSES = ['probe', 'crawler', 'metrics', 'logs', 'canary', 'report'] as const;
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
  'scoreboard',
] as const;
export type Actor = (typeof ACTORS)[number];

/** Who answers a model call: Anthropic's API, Amazon Bedrock, or a model running on Martin's Mac (LM Studio). */
export const MODEL_PROVIDERS = ['anthropic', 'bedrock', 'local'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** The agents that call a model through the gateway, from a runner: each has a model and effort Martin chooses. */
export const MODEL_AGENTS = ['planner', 'coder', 'reviewer', 'describer'] as const satisfies readonly Agent[];
export type ModelAgent = (typeof MODEL_AGENTS)[number];

/** Claude's efforts, least first. A local model takes none. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** The spend caps Martin sets, as a settings change names them. */
export const SPEND_CAPS = ['day', 'month', 'work-item'] as const;
export type SpendCap = (typeof SPEND_CAPS)[number];

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
  /**
   * Triage held a burst: one sense found more new problems at once than a handful, so their tickets wait, unopened,
   * for Martin to look at what it saw before any reaches Plan.
   */
  'burst',
  /**
   * Triage held a sense's new problem because something the sense reads besides the app was not seen to be healthy
   * when it saw it: the problem may be the factory's environment, which no agent can mend, so it waits for Martin.
   */
  'environment',
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
  /**
   * The reviewer found the spec or the change going beyond what the ticket asks: the coder cannot put a spec right, so
   * Martin's answer sends it back to the planner.
   */
  'beyond-ticket',
  /** The change passed its gates and review, and waits for Martin to merge it. */
  'merge',
  /**
   * The change is merged and waits at Release for a deploy pull request to carry it, which Martin merges. A release
   * that carries it ends the hold by itself; one that rolls back, that Martin aborts, or whose analysis errs, holds it
   * again, for the next or for his retry.
   */
  'deploy',
  /** Verification after the release could not settle the ticket by itself, and waits for Martin to say. */
  'verify',
  /** The work item has spent as much on models as one may: the gateway refuses its agents' calls. */
  'spend',
  /** The change's new tests pass without the fix (the tests-first check), so they prove nothing about it. */
  'tests-first',
  'unknown',
] as const;
export type HoldCause = (typeof HOLD_CAUSES)[number];

/**
 * Where the deploy pull request that carries a work item held for a deploy stands, as the line reads it from GitHub:
 * open with the required checks on its head running, all passed, or one failed; merged; or closed unmerged. Only once
 * its checks have passed does it wait for Martin.
 */
export const DEPLOY_STATES = ['checking', 'passed', 'failed', 'merged', 'closed'] as const;
export type DeployState = (typeof DEPLOY_STATES)[number];

/** Martin's answers to a hold: approve it, reject it, or answer it in words. */
export const HOLD_ANSWERS = ['approved', 'rejected', 'answered'] as const;
export type HoldAnswer = (typeof HOLD_ANSWERS)[number];

export const AUTONOMY = ['supervised', 'guarded', 'lights-out'] as const;
export type Autonomy = (typeof AUTONOMY)[number];

/**
 * Martin's controls of the line, from the console's Controls (the admin service): the autonomy level, whether agents
 * take new work, whether low-risk changes merge by themselves, and what the line takes. Auto-rollback is not one until
 * Part C gives it a switch: a failing canary is always rolled back.
 */
export const LINE_CONTROLS = ['autonomy', 'new-work', 'auto-merge', 'take'] as const;
export type LineControl = (typeof LINE_CONTROLS)[number];

/** What the line takes: every ticket, the next few from when Martin set it, or just one work item. */
export const TAKES = ['every', 'next-few', 'just-one'] as const;
export type TakeKind = (typeof TAKES)[number];

/** Tags that route a change to a human, depending on autonomy (docs/COMPONENTS/APPROVAL-ROUTING.md). */
export const RISKS = ['test-loosening', 'dependency-change', 'security-headers', 'out-of-scope'] as const;
export type Risk = (typeof RISKS)[number];

/**
 * Tags that hold a spec for Martin in every autonomy mode: a guardrail, not something the autonomy level decides. A
 * fix that changes behaviour beyond what its ticket is about needs a person, whatever the line is trusted with.
 */
export const ALWAYS_HELD: readonly Risk[] = ['out-of-scope'];

/**
 * Martin's controls of a canary in flight, from the console's Canary panel (the admin service): promote it to the next
 * step's weight, or fully; pause it, and give it back to its analysis; abort it; and retry a release that was stopped.
 * A rollback stays the analysis's alone, so there is no such control.
 */
export const RELEASE_CONTROLS = ['promote', 'promote-fully', 'pause', 'resume', 'abort', 'retry'] as const;
export type ReleaseControl = (typeof RELEASE_CONTROLS)[number];

/** The only types an artifact may have. The console serves each with the type it was stored with, never a guess. */
export const ARTIFACT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'text/plain', 'application/json'] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** The most steps of a canary a release's start records. */
export const MAX_CANARY_STEPS = 20;

/** The most findings one review carries, so each reaches the events whole. */
export const MAX_FINDINGS = 20;
