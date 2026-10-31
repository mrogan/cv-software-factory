/**
 * Who may record a refusal (`action.refused`), by its mechanism, and which of spec 6's guardrails each shows. A
 * mechanism with a role of its own in the event store appends its own refusals; one with none (the GitHub worker,
 * admission control, GitHub itself) is relayed by the worker that asked it, which holds a role. Row security holds
 * every refusal to the roles named here (`packages/store/migrations/0040_refusals-by-mechanism.sql`), and to the
 * guardrails named here (`0041_refusals-as-they-read.sql`); `packages/store/test/grants.test.ts` fails unless the
 * store's tables equal these, and inserts each mechanism as every role.
 *
 * The red-team harness's role (`factory_redteam`, which will relay what the GitHub worker refused an attack and record
 * the egress attack's own attempts) is not here yet: the task that makes the role adds it.
 *
 * Human-owned: see `README.md`.
 */
import type { RefusalMechanism } from '../packages/events/src/vocabulary.ts';

export interface RefusalRule {
  /** What refuses, and from what the refusal is recorded. */
  for: string;
  /** The store's roles that may append it: none, while it has no producer. */
  appendedBy: readonly string[];
  /** The guardrails it shows, by why it refused: the appender, which knows why, chooses. */
  guardrails: Readonly<Record<string, readonly number[]>>;
}

export const REFUSALS = {
  'scope-fence': {
    for: "The coder's scope fence, refusing a patch that changes a file outside its spec's scope: the fence's output.",
    appendedBy: ['factory_line'],
    guardrails: { outside: [11] },
  },
  'github-guard': {
    for:
      "The GitHub worker's own guard, before it asks GitHub: a protected path, a branch or a deploy it does not own, an " +
      "issue or pull request it did not open. The worker's signed answer, relayed by the worker that asked.",
    appendedBy: ['factory_line'],
    guardrails: { protected: [1], branch: [1], deploy: [1], issue: [10] },
  },
  'token-permission': {
    for: "GitHub refusing a write with the App's token, with status 403: the GitHub worker's signed answer, relayed.",
    appendedBy: ['factory_line'],
    guardrails: { forbidden: [1] },
  },
  'review-gate': {
    for: 'The review check refusing a pull request: its run, read and signed by the GitHub worker, relayed.',
    appendedBy: ['factory_line'],
    guardrails: { risk: [2], 'code-owned': [1] },
  },
  gateway: {
    for: 'The gateway refusing a model call: its own refusal.',
    appendedBy: ['factory_gateway'],
    guardrails: { cap: [7], policy: [6], stopped: [9] },
  },
  'typed-judgement': {
    for: "Triage quarantining a report: Jev's typed answers, with their probabilities.",
    appendedBy: ['factory_triage'],
    guardrails: { quarantined: [8] },
  },
  'egress-policy': {
    for: "The runners' NetworkPolicy refusing a connection: the egress attack's own record of each attempt.",
    appendedBy: [],
    guardrails: { egress: [5] },
  },
  'admission-control': {
    for: "Kyverno or a ValidatingAdmissionPolicy in a guarded namespace: the cluster's Events, read by the line.",
    appendedBy: ['factory_line'],
    guardrails: { image: [3], production: [4] },
  },
  ruleset: {
    for: "GitHub's ruleset on the repository. Nothing records one yet.",
    appendedBy: [],
    guardrails: { repository: [1] },
  },
} as const satisfies Record<RefusalMechanism, RefusalRule>;

/** Why a mechanism refused, as its row in `REFUSALS` names the causes it tells apart. */
export type RefusalCause<M extends RefusalMechanism> = keyof (typeof REFUSALS)[M]['guardrails'];

/** The guardrails a refusal shows, for its mechanism and why it refused. */
export function guardrailsFor<M extends RefusalMechanism>(mechanism: M, cause: RefusalCause<M>): number[] {
  return [...(REFUSALS[mechanism].guardrails as Record<RefusalCause<M>, readonly number[]>)[cause]];
}

/** Whether a role may append a refusal by a mechanism. */
export const mayAppend = (mechanism: RefusalMechanism, role: string): boolean =>
  (REFUSALS[mechanism].appendedBy as readonly string[]).includes(role);

/**
 * The restrictive insert policy on `events` that holds each refusal to its mechanism's roles, as the grants test reads
 * it from the store: every role's insert must meet it as well as its own. Martin's command line appends a refusal only
 * as a sample.
 */
export const REFUSAL_ROWS =
  "(type <> 'action.refused') OR (CURRENT_USER = ANY (refusal_appenders((payload ->> 'mechanism')))) OR " +
  "((CURRENT_USER = 'factory_operator'::name) AND sample)";

/**
 * The restrictive insert policy beside it that holds a refusal to what the console reads of it
 * (`0041_refusals-as-they-read.sql`): its public view names its mechanism and guardrails, and it names only guardrails
 * its mechanism shows here, or, from before version 3, none and a mechanism version 2 knew.
 */
export const REFUSAL_READS =
  "(type <> 'action.refused') OR ((((public -> 'payload') -> 'mechanism') = (payload -> 'mechanism')) AND " +
  "(NOT (((public -> 'payload') -> 'guardrails') IS DISTINCT FROM (payload -> 'guardrails'))) AND CASE " +
  "WHEN (version >= 3) THEN ((jsonb_typeof((payload -> 'guardrails')) = 'array') AND " +
  "((payload -> 'guardrails') <> '[]'::jsonb) AND " +
  "((payload -> 'guardrails') <@ refusal_guardrails((payload ->> 'mechanism')))) " +
  "ELSE ((payload ->> 'mechanism') = ANY (ARRAY['token-permission', 'ruleset', 'egress-policy', " +
  "'admission-control', 'scope-fence'])) END)";
