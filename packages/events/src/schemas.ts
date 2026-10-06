/**
 * The shape of every event, checked with Zod when it is appended. An event that fails is refused, with the reason.
 *
 * Node only: the browser imports types from here, never values, so Zod stays out of the console's bundle.
 */
import { z } from 'zod';
import { type EventType, LINE_TYPES, VERSIONS } from './versions.ts';
import * as V from './vocabulary.ts';

const text = (max: number) => z.string().trim().min(1).max(max);
const count = z.number().int().nonnegative();
const probability = z.number().min(0).max(1);
const usd = z.number().nonnegative().max(1000);
const slug = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'a SHA-256, in lower-case hex');
const commit = z.string().regex(/^[0-9a-f]{40}$/, 'a full commit SHA');
const traceId = z.string().regex(/^[0-9a-f]{32}$/, 'a W3C trace id');
const timestamp = z.iso.datetime({ offset: true });
const route = z
  .string()
  .regex(/^\/[^\s]*$/, 'a path, such as /products/:slug')
  .max(200);
/** A route, or `*` for a symptom found on every page the senses checked. */
const routeOrEvery = z.union([route, z.literal('*')]);
/** A work item's number, as the store gives it. */
const workItem = z.string().regex(/^[1-9]\d{0,8}$/, 'a work item number, such as 1288');
/** The app's version, as `/version` reports it: a release such as v0.9.3, or a commit. */
const appVersion = z.string().regex(/^(v\d+\.\d+\.\d+|[0-9a-f]{7,40})$/, 'a version such as v0.9.3, or a commit');
const pullRequest = z.number().int().positive();
const stage = z.enum(V.STAGES);
const severities = z.strictObject({ critical: count, high: count, medium: count, low: count });

/** Where on a page something is, in CSS pixels from the top left of the screenshot. */
const rect = {
  x: z.number().nonnegative(),
  y: z.number().nonnegative(),
  width: z.number().positive(),
  height: z.number().positive(),
};

/** Where on a screenshot the probe looked: a problem it found, or the thing as it should be. */
const box = z.strictObject({ ...rect, kind: z.enum(['problem', 'fix']), label: text(48).optional() });

/** An artifact is named by the SHA-256 of its contents. The console serves it with the type recorded here. */
export const artifactRef = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('screenshot'),
    hash: sha256,
    type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    size: count,
    route,
    version: appVersion,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    boxes: z.array(box).max(4),
  }),
  z.strictObject({
    kind: z.literal('file'),
    hash: sha256,
    type: z.enum(V.ARTIFACT_TYPES),
    size: count,
    name: text(120),
  }),
]);

/**
 * Evidence small enough to keep in the event itself: a metric series; log lines and the trace they link to; an HTTP
 * exchange; what a browser's console said; or what an accessibility check found.
 */
export const evidence = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('metric'),
    name: text(80),
    unit: text(16),
    objective: z.number().optional(),
    start: timestamp,
    stepSeconds: z.number().int().positive(),
    values: z.array(z.number().nullable()).min(2).max(500),
    marker: z.strictObject({ index: count, label: text(48) }).optional(),
  }),
  z.strictObject({
    kind: z.literal('logs'),
    route,
    version: appVersion,
    /** How many requests the lines cover, so that none at all says something. */
    requests: count,
    lines: z
      .array(
        z.strictObject({
          ts: timestamp,
          level: z.enum(['debug', 'info', 'warn', 'error']),
          message: text(300),
          traceId: traceId.nullable(),
        }),
      )
      // None at all is evidence too: a route that leaves no log record.
      .max(20),
    trace: z
      .strictObject({
        id: traceId,
        spans: z
          .array(z.strictObject({ name: text(80), offsetMs: count, durationMs: count, note: text(48).optional() }))
          .max(20),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal('http'),
    method: z.enum(['GET', 'HEAD', 'POST']),
    /** The path asked for, with any query the sense chose. Never a visitor's: senses make their own requests. */
    url: z
      .string()
      .regex(/^\/[^\s]*$/, 'a path, such as /products?page=2')
      .max(300),
    /** Null when no response came. */
    status: z.number().int().min(100).max(599).nullable(),
    /** The headers the check looked at, by lower-case name, each null when absent. */
    headers: z.record(z.string().regex(/^[a-z0-9-]+$/), z.string().max(300).nullable()),
    timings: z.strictObject({ firstByteMs: count, totalMs: count }),
    /** Each redirect followed on the way, in order. */
    redirects: z.array(z.strictObject({ status: z.number().int().min(300).max(399), location: text(300) })).max(20),
  }),
  z.strictObject({
    kind: z.literal('console'),
    route,
    version: appVersion,
    messages: z
      .array(z.strictObject({ level: z.enum(['error', 'warning']), text: text(300), source: text(300).optional() }))
      .min(1)
      .max(20),
  }),
  z.strictObject({
    kind: z.literal('accessibility'),
    route,
    version: appVersion,
    findings: z
      .array(
        z.strictObject({
          /** axe's rule, such as `image-alt`. */
          rule: slug,
          impact: z.enum(['minor', 'moderate', 'serious', 'critical']),
          help: text(200),
          /** The elements concerned, and where they are on the signal's screenshot when they are in view. */
          elements: z
            .array(z.strictObject({ selector: text(300), box: z.strictObject(rect).optional() }))
            .min(1)
            .max(10),
        }),
      )
      .min(1)
      .max(20),
  }),
]);

/** One answer from Jev (TYPESAFE.md): a label, a level on a rubric, or the probability of yes. Never free text. */
const answer = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('choice'),
    key: slug,
    question: text(300),
    answer: slug,
    probabilities: z.record(slug, probability),
  }),
  z.strictObject({
    type: z.literal('score'),
    key: slug,
    question: text(300),
    levels: z.array(text(40)).min(2).max(10),
    probabilities: z.array(probability).min(2).max(10),
    expected: z.number().nonnegative(),
  }),
  z.strictObject({ type: z.literal('noul'), key: slug, question: text(300), probability }),
]);

/**
 * What a visitor sent through the widget. Untrusted: its text never reaches a public view or a generative agent.
 * The text is absent from an event read back from a public record, such as an event-log file.
 */
const report = z.strictObject({ page: route, text: z.string().min(1).max(2000).optional() });

/** An open ticket offered to triage as one a report might repeat: described from its typed fields, never a report. */
const candidate = z.strictObject({
  /** The label the question gives it. */
  key: slug,
  workItem,
  title: text(120),
  category: z.enum(V.DEFECT_CATEGORIES),
  symptom: z.enum(V.SYMPTOM_CLASSES).optional(),
});

/** A passage of a page's text, as the factory read the page itself, offered as the one a content report is about. */
const passage = z.strictObject({ key: slug, text: text(200) });

/** A canary against its baseline, on the same measure. */
const versus = <T extends z.ZodType>(value: T) => z.strictObject({ canary: value, baseline: value });

/** The payload of each event type, at its current version. */
export const PAYLOADS = {
  'work-item.opened': z.strictObject({
    kind: z.enum(V.KINDS),
    title: text(120),
    /** Written by hand to show the console, not done by the factory. A store holds samples or real events, never both. */
    sample: z.boolean(),
    category: z.enum(V.CATEGORIES).optional(),
    /** The visitor whose key started it. Their key is a credential, so no public view carries it. */
    visitor: z.strictObject({ key: z.string().regex(/^[a-z]+-[a-z]+$/) }).optional(),
    dependency: z
      .strictObject({
        name: text(120),
        ecosystem: z.enum(['npm', 'docker']),
        from: text(40),
        to: text(40),
        security: z.boolean(),
      })
      .optional(),
  }),
  'work-item.summarised': z.strictObject({
    title: text(120),
    /** Two lines on a card. */
    description: text(260),
    /** A paragraph at the top of the sheet. */
    story: text(1200),
  }),
  'work-item.closed': z.strictObject({
    /** How it ended. Triage ends a report it quarantines or discards; anything else ends after the line. */
    outcome: z.enum(['verified', 'rolled-back', 'no-change', 'quarantined', 'discarded']),
    reason: text(200),
  }),

  'defect.injected': z.strictObject({ choice: text(80), version: appVersion, pullRequest }),
  'attack.launched': z.strictObject({ attack: text(120), expected: text(120) }),

  /**
   * What a sense found, or what a visitor reported. A sense's signal names the symptom class it saw; a report's
   * is for triage to judge. On an open ticket, the first signal from each sense adds its evidence.
   */
  'signal.received': z.strictObject({
    sense: z.enum(V.SENSES),
    check: text(80),
    route: routeOrEvery,
    version: appVersion,
    symptom: z.enum(V.SYMPTOM_CLASSES).optional(),
    report: report.optional(),
    evidence: z.array(evidence).max(8).optional(),
  }),
  /**
   * One request to Jev about a report: what it was asked and answered. The request that routes the report records
   * where it went; one that only chooses a content report's passage from its page has no route.
   */
  'judgement.made': z
    .strictObject({
      questionSet: z.string().regex(/^[a-z-]+\/v\d+$/),
      model: z.string().regex(/^jev-\d+\.\d+\.\d+$/),
      state: z.strictObject({
        report,
        /** The open tickets on the same page it was offered, besides "none of these". */
        candidates: z.array(candidate).max(10).optional(),
        passages: z.array(passage).max(40).optional(),
      }),
      answers: z.array(answer).min(1).max(20),
      route: z.enum(V.TRIAGE_ROUTES).optional(),
      /** The open ticket a repeat joined. */
      joined: workItem.optional(),
      costUsd: usd,
      durationMs: count,
      cassette: sha256,
    })
    .refine((j) => (j.route === 'repeat') === (j.joined !== undefined), 'a repeat names the ticket it joined'),
  'ticket.opened': z.strictObject({
    title: text(120),
    category: z.enum(V.DEFECT_CATEGORIES),
    severity: z.enum(V.SEVERITIES),
    fingerprint: z.union([
      z.strictObject({ route: routeOrEvery, class: z.enum(V.SYMPTOM_CLASSES) }),
      /** For content: the page, and the passage of its text that is wrong, as the factory read it. */
      z.strictObject({ page: route, text: text(200) }),
    ]),
    traces: z.array(traceId).max(10),
  }),

  'spec.written': z.strictObject({
    outcome: text(200),
    /** Given, when, then. `expect` holds the then, because an object with a `then` looks like a promise. */
    criteria: z
      .array(z.strictObject({ given: text(200), when: text(200), expect: text(200) }))
      .min(1)
      .max(12),
    scope: z.array(text(200)).min(1).max(40),
    risks: z.array(z.enum(V.RISKS)).max(V.RISKS.length),
    rollout: text(300),
    flag: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
  }),
  /** A change pushed for review: a new pull request, or another attempt on one that was sent back. */
  'pull-request.pushed': z.strictObject({
    number: pullRequest,
    title: text(200),
    branch: text(120),
    attempt: z.number().int().positive(),
    testsFirst: z.boolean(),
    files: z
      .array(z.strictObject({ path: text(200), added: count, removed: count }))
      .min(1)
      .max(200),
  }),

  'gates.started': z.strictObject({ pullRequest, commit, checks: z.array(text(80)).min(1).max(40) }),
  'gate.finished': z.strictObject({
    pullRequest,
    commit,
    check: text(80),
    conclusion: z.enum(['success', 'failure', 'skipped']),
    required: z.boolean(),
    durationMs: count,
    summary: text(200).optional(),
    /** The check's own output, verbatim. Public views redact anything secret-shaped. */
    output: z.string().max(4000).optional(),
    findings: z.strictObject({ before: severities, after: severities }).optional(),
  }),
  'gates.finished': z.strictObject({
    pullRequest,
    commit,
    conclusion: z.enum(['passed', 'failed']),
    passed: count,
    failed: z.array(text(80)).max(40),
  }),
  /**
   * The reviewer's review of a pull request's latest push, with each finding: the line it is anchored to, whether it
   * blocks, what it cites (a rule of the repository's `docs/REVIEWERS.md`, a criterion of the spec, or both) and its
   * comment, so the console can show the thread and the rules can be counted by how often they are cited.
   */
  'review.submitted': z.strictObject({
    pullRequest,
    verdict: z.enum(['approved', 'changes-requested', 'escalated']),
    note: text(300),
    findings: z
      .array(
        z.strictObject({
          path: text(200),
          /** In the change's version of the file. */
          line: z.number().int().positive(),
          blocking: z.boolean(),
          rule: z.number().int().min(1).max(50).optional(),
          criterion: z.number().int().min(1).max(12).optional(),
          comment: text(300),
        }),
      )
      .max(V.MAX_FINDINGS),
  }),
  'pull-request.merged': z.strictObject({ number: pullRequest, commit, by: z.enum(['martin', 'factory']) }),

  'release.started': z.strictObject({
    version: appVersion,
    previous: appVersion,
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    signed: z.boolean(),
    admitted: z.boolean(),
  }),
  'canary.stepped': z.strictObject({
    version: appVersion,
    weight: z.number().int().min(1).max(100),
    analysis: z.strictObject({
      errorRate: versus(probability),
      p99Ms: versus(count),
      journeys: versus(z.tuple([count, count])),
    }),
  }),
  'release.promoted': z.strictObject({ version: appVersion, previous: appVersion }),
  'release.rolled-back': z.strictObject({
    version: appVersion,
    restored: appVersion,
    weight: z.number().int().min(1).max(100),
    reason: text(200),
    analysis: z.strictObject({
      metric: text(60),
      unit: text(16),
      stepSeconds: z.number().int().positive(),
      canary: z.array(z.number().nullable()).min(2).max(500),
      baseline: z.array(z.number()).min(2).max(500),
      /** Where in the series the rollback happened. */
      at: count,
    }),
  }),
  'verification.finished': z.strictObject({
    outcome: z.enum(['cleared', 'persists']),
    check: text(120),
    /** The version every page was compared with. */
    against: appVersion,
    evidence: evidence.optional(),
    pages: z
      .array(
        z.strictObject({
          page: text(60),
          route,
          screenshot: sha256,
          /** The share of pixels that differ from the same page on `against`. */
          changed: z.number().min(0).max(1),
          intended: z.boolean(),
        }),
      )
      .max(12),
  }),

  'work.returned': z
    .strictObject({ from: stage, to: stage, reason: text(200) })
    .refine((r) => V.STAGES.indexOf(r.to) < V.STAGES.indexOf(r.from), 'work returns upstream, to an earlier stage'),
  'hold.started': z.strictObject({
    stage,
    /** Approval and questions are the line asking; held means a mechanism stopped the work for a human to decide. */
    kind: z.enum(['approval', 'question', 'held']),
    /** Why, so that Martin's answer has a meaning: what each answer does depends on it. */
    cause: z.enum(V.HOLD_CAUSES),
    reason: text(300),
    question: text(300).optional(),
  }),
  'hold.answered': z.strictObject({
    decision: z.enum(['approved', 'rejected', 'answered']),
    answer: text(300).optional(),
  }),
  /**
   * A mechanism stopped an action: the platform's (a token's permissions, a ruleset, the egress policy, admission
   * control) or the line's own scope fence, which refuses a coder's patch that changes a file outside its spec's scope.
   */
  'action.refused': z.strictObject({
    mechanism: z.enum(['token-permission', 'ruleset', 'egress-policy', 'admission-control', 'scope-fence']),
    action: text(200),
    /** The mechanism's own refusal, verbatim. */
    output: z.string().min(1).max(4000),
  }),
  /** One agent's step: every call it made, summed. The gateway's `model_calls` table keeps each call. */
  'model.called': z.strictObject({
    agent: z.enum(V.AGENTS),
    provider: z.enum(V.MODEL_PROVIDERS),
    /** A pinned model: `claude-sonnet-5-5`, or a local one such as `qwen/qwen3.8-27b`. */
    model: z.string().regex(/^[a-z0-9][a-z0-9./_-]{0,79}$/),
    settings: z.strictObject({
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
      maxTurns: z.number().int().positive().optional(),
    }),
    tokens: z.strictObject({ input: count, output: count, cacheRead: count, cacheWrite: count }),
    costUsd: usd,
    durationMs: count,
    /** How many calls the step made. */
    calls: z.number().int().positive(),
  }),

  'line.started': z.strictObject({ autonomy: z.enum(V.AUTONOMY) }),
  'line.stopped': z.strictObject({ reason: text(200) }),
  /**
   * Model calls wait (guardrail 7). Either the factory's own day or month cap is reached, and the gateway refuses
   * calls until it resets; or a provider refuses for a cap the factory does not own (the account's credit is spent,
   * the workspace's limit is reached, or the local model is not running), and agent calls wait until it answers.
   */
  'spend.capped': z.discriminatedUnion('cap', [
    z.strictObject({
      cap: z.enum(['day', 'month']),
      limitUsd: usd,
      spentUsd: usd,
      resets: timestamp,
    }),
    z.strictObject({
      cap: z.literal('provider'),
      provider: z.enum(V.MODEL_PROVIDERS),
      reason: z.enum(V.PROVIDER_CAPS),
      /** The provider's own words, or what the gateway saw when it could not connect. */
      message: text(300),
    }),
  ]),
  'spend.cleared': z.discriminatedUnion('cap', [
    z.strictObject({ cap: z.enum(['day', 'month']) }),
    z.strictObject({ cap: z.literal('provider'), provider: z.enum(V.MODEL_PROVIDERS) }),
  ]),
} satisfies { [K in EventType]: z.ZodType };

/** The envelope of an event about to be appended: everything but `seq` and `public`, which the store adds. */
export const newEvent = z.strictObject({
  id: z.uuid(),
  ts: timestamp,
  work_item: workItem.nullable(),
  type: z.enum(Object.keys(VERSIONS) as [EventType, ...EventType[]]),
  version: z.number().int().positive(),
  actor: z.enum(V.ACTORS),
  summary: text(200),
  payload: z.unknown(),
  artifacts: z.array(artifactRef).max(40),
});

export type Validated = { ok: true } | { ok: false; problems: string[] };

/**
 * A signal as a sense leaves it in the inbox: what `signal.received` will say if triage makes an event of it, when
 * the sense saw it, and its artifacts.
 */
export const inboxSignal = z
  .intersection(
    PAYLOADS['signal.received'],
    z.object({
      observedAt: timestamp,
      /** What the sense saw, in a line, for the event's summary. A report has none: its text is never a summary. */
      summary: text(200).optional(),
      artifacts: z.array(artifactRef).max(10),
    }),
  )
  .superRefine((signal, context) => {
    // A report is its text: one without any is nothing to judge, and nothing to answer.
    if (signal.sense === 'report' && !signal.report?.text) {
      context.addIssue({ code: 'custom', path: ['report', 'text'], message: 'a report needs its text' });
    }
    if (signal.sense !== 'report' && signal.report) {
      context.addIssue({ code: 'custom', path: ['report'], message: 'only a report carries a report' });
    }
  });

/** Checks a signal before it goes in the inbox, so a sense cannot leave triage something it would refuse. */
export function validateSignal(input: unknown): Validated {
  const result = inboxSignal.safeParse(input);
  return result.success ? { ok: true } : { ok: false, problems: problemsOf(result.error) };
}

/** Checks an event's envelope and payload against the current version of its type. */
export function validate(input: unknown): Validated {
  const envelope = newEvent.safeParse(input);
  if (!envelope.success) return { ok: false, problems: problemsOf(envelope.error) };
  const event = envelope.data;
  const problems: string[] = [];
  if (event.version !== VERSIONS[event.type]) {
    problems.push(`version ${event.version} of ${event.type} is not current; append version ${VERSIONS[event.type]}`);
  }
  const line = LINE_TYPES.includes(event.type);
  if (line && event.work_item !== null) problems.push(`${event.type} belongs to the line, not to a work item`);
  if (!line && event.work_item === null) problems.push(`${event.type} needs a work item`);
  const payload = PAYLOADS[event.type].safeParse(event.payload);
  if (!payload.success) problems.push(...problemsOf(payload.error, 'payload'));
  return problems.length ? { ok: false, problems } : { ok: true };
}

function problemsOf(error: z.ZodError, prefix?: string): string[] {
  return error.issues.map((issue) => {
    const path = [...(prefix ? [prefix] : []), ...issue.path.map(String)].join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
}
