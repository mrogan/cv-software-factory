/**
 * One work item in full, at time t: what happened, a chapter per step through the line with the site as it was
 * at each, the evidence, the change, the facts, the agents and models, and the gates.
 */
import type {
  DefectCategory,
  Kind,
  PayloadOf,
  PublicEvent,
  Screenshot,
  Sense,
  SymptomClass,
} from '@software-factory/events';
import { SENSES } from '@software-factory/events';
import type { Capture, ItemState } from './items.ts';
import { type Card, card, type Picture, pictureOfSignal } from './reel.ts';

export interface Chapter {
  label: string;
  at: number;
  actor: PublicEvent['actor'] | undefined;
  text: string;
  /** Where along the scrubber, from 0 to 100. */
  position: number;
  /** The site's screenshot as it stood at this point, if the factory had captured one. */
  site: Capture | undefined;
  tone: 'signal' | 'ok' | 'attn' | 'faint';
  /** The chapter where the work waits for a stage to take it, drawn as a larger hollow ring. */
  waiting?: boolean;
}

export interface AgentRow {
  agent: string;
  /** Who served the calls, read from the events: Jev is always TypeSafe's; Claude is Anthropic's or Bedrock's. */
  provider: PayloadOf<'model.called'>['provider'] | 'typesafe';
  model: string;
  /** The settings, or for Jev each question set asked and how many questions it holds. */
  details: string[];
  calls: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface GateRow {
  check: string;
  conclusion: 'success' | 'failure' | 'skipped';
  durationMs: number;
}

export interface PageComparison {
  page: string;
  screenshot: Screenshot | undefined;
  changed: number;
  intended: boolean;
}

/** One sense that saw a ticket's problem: the check it ran, and when it first saw it. */
export interface Sighting {
  sense: Sense;
  check: string | undefined;
  at: number | undefined;
  /** The sense whose signal opened the ticket. */
  opened: boolean;
  /** What it added, in a few words. */
  added: string | undefined;
}

/** One sense's evidence, the first time it saw the problem. */
export interface SenseEvidence {
  sense: Sense;
  at: number;
  picture: Picture;
}

export interface Sheet {
  card: Card;
  /** A visitor's report: shown as withheld here, since only Martin and its author may read its text. */
  report: { page: string; quarantined: boolean } | undefined;
  story: string;
  chapters: Chapter[];
  /** Screenshots taken at the signal, on the canary and at rollout, for the evidence. */
  captures: Capture[];
  pages: { against: string; list: PageComparison[] } | undefined;
  spec: PayloadOf<'spec.written'> | undefined;
  files: PayloadOf<'pull-request.pushed'>['files'] | undefined;
  facts: {
    foundBy: string;
    humanLines: number;
    /** A ticket's category and severity, and its fingerprint in words. */
    ticket: { category: string; severity: string; fingerprint: string } | undefined;
  };
  /** For a ticket: every sense, those that saw it first, in the order they did. */
  seenBy: Sighting[] | undefined;
  /** For a ticket more than one sense saw: each one's evidence, the first time it saw it. */
  senseEvidence: SenseEvidence[];
  agents: AgentRow[];
  /** Why no model was called, when none was. */
  noModel: string | undefined;
  gates: GateRow[];
}

const SENSE: Record<Sense, string> = {
  probe: 'Probe',
  crawler: 'Crawler',
  metrics: 'Metrics',
  logs: 'Logs',
  report: 'Visitor report',
};

/** Who or what noticed the work, in a few words. */
function foundBy(item: ItemState): string {
  const signal = item.events.find((event) => event.type === 'signal.received');
  if (item.openedBy === 'martin') return 'Martin, from the console';
  if (item.openedBy === 'dependabot') return 'Dependabot';
  if (item.kind === 'red-team') return 'Red-team harness';
  if (signal?.type === 'signal.received') {
    return signal.payload.sense === 'report'
      ? SENSE.report
      : `${SENSE[signal.payload.sense]} · ${signal.payload.check}`;
  }
  return 'The factory';
}

/** Openings worth a chapter of their own; the others open as their first signal or pull request arrives. */
const OPENING: Partial<Record<Kind, string>> = {
  improvement: 'REQUEST',
  'red-team': 'ATTACK',
  'injected-defect': 'INJECT',
};

/** The label for an event that marks a step in the item's story, or nothing for those that don't. */
function chapterOf(event: PublicEvent, item: ItemState): Pick<Chapter, 'label' | 'tone'> | undefined {
  switch (event.type) {
    case 'work-item.opened': {
      const label = OPENING[item.kind];
      return label ? { label, tone: 'signal' } : undefined;
    }
    case 'defect.injected':
      return { label: 'ON SITE', tone: 'attn' };
    case 'signal.received':
      // Once there is a ticket, a signal is another sense adding its evidence: it is named by its sense.
      if (event.payload.sense !== 'report' && item.ticket && ticketedBefore(item, event)) {
        return { label: event.payload.sense.toUpperCase(), tone: 'signal' };
      }
      return { label: event.payload.sense === 'report' ? 'REPORT' : 'SIGNAL', tone: 'signal' };
    case 'judgement.made':
      return { label: 'TRIAGE', tone: 'signal' };
    case 'ticket.opened':
      return { label: 'TICKET', tone: 'signal' };
    case 'spec.written':
      return { label: 'SPEC', tone: 'signal' };
    case 'hold.started':
      return { label: { approval: 'WAITING', question: 'QUESTION', held: 'HELD' }[event.payload.kind], tone: 'attn' };
    case 'hold.answered':
      return { label: event.payload.decision === 'rejected' ? 'REJECTED' : 'APPROVED', tone: 'signal' };
    case 'pull-request.pushed':
      return { label: event.payload.attempt > 1 ? `TRY ${event.payload.attempt}` : 'PR', tone: 'signal' };
    case 'gates.finished':
      return { label: 'GATES', tone: event.payload.conclusion === 'passed' ? 'signal' : 'attn' };
    case 'work.returned':
      return { label: 'SENT BACK', tone: 'attn' };
    case 'review.submitted':
      return { label: 'REVIEW', tone: 'signal' };
    case 'canary.stepped':
      return { label: 'CANARY', tone: 'signal' };
    case 'release.promoted':
      return { label: 'ROLLED OUT', tone: 'signal' };
    case 'release.rolled-back':
      return { label: 'ROLLED BACK', tone: 'attn' };
    case 'verification.finished':
      return event.payload.outcome === 'cleared'
        ? { label: 'VERIFIED', tone: 'ok' }
        : { label: 'REOPENED', tone: 'attn' };
    case 'action.refused':
      return { label: 'REFUSED', tone: 'attn' };
    case 'work-item.closed':
      // A guardrail that worked needs nobody: quarantine is told in the quiet tone, as closed work is.
      if (event.payload.outcome === 'quarantined') return { label: 'QUARANTINED', tone: 'faint' };
      return event.payload.outcome === 'no-change' || event.payload.outcome === 'discarded'
        ? { label: 'CLOSED', tone: 'faint' }
        : undefined;
    default:
      return undefined;
  }
}

/** Whether the item's ticket had opened before an event. */
const ticketedBefore = (item: ItemState, event: PublicEvent) => {
  const opened = item.events.findIndex((e) => e.type === 'ticket.opened');
  return opened >= 0 && opened < item.events.indexOf(event);
};

/** Positions along the scrubber: by time, but never closer than a minimum gap, so labels stay apart. */
export function spread(times: readonly number[], start: number, end: number, gap = 7.5): number[] {
  const span = Math.max(1, end - start);
  const raw = times.map((at) => Math.min(100, Math.max(0, ((at - start) / span) * 100)));
  const out: number[] = [];
  for (const [i, p] of raw.entries()) out.push(i === 0 ? p : Math.max(p, (out[i - 1] ?? 0) + gap));
  // Squeeze back into 0–100 if the gaps pushed past the end.
  const over = (out.at(-1) ?? 0) - 100;
  if (over > 0) {
    const first = out[0] ?? 0;
    const scale = (100 - first) / ((out.at(-1) ?? 100) - first || 1);
    return out.map((p) => first + (p - first) * scale);
  }
  return out;
}

const SETTINGS = (settings: PayloadOf<'model.called'>['settings']) =>
  [settings.effort && `effort ${settings.effort}`, settings.maxTurns && `≤ ${settings.maxTurns} turns`]
    .filter(Boolean)
    .join(' · ');

function agents(item: ItemState): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  // Jev's questions, by question set, in the order first asked: each set's row line says how many it holds.
  const asked = new Map<string, number>();
  for (const event of item.events) {
    if (event.type === 'model.called') {
      const { agent, provider, model, settings, tokens, costUsd } = event.payload;
      const key = `${agent}/${provider}/${model}`;
      const row = rows.get(key) ?? {
        agent,
        provider,
        model,
        details: [SETTINGS(settings)].filter(Boolean),
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      };
      row.calls += event.payload.calls;
      row.tokensIn += tokens.input + tokens.cacheRead + tokens.cacheWrite;
      row.tokensOut += tokens.output;
      row.cost += costUsd;
      rows.set(key, row);
    } else if (event.type === 'judgement.made') {
      const key = `triage/typesafe/${event.payload.model}`;
      const row = rows.get(key) ?? {
        agent: 'triage',
        provider: 'typesafe',
        model: event.payload.model,
        details: [],
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      };
      if (!asked.has(event.payload.questionSet)) asked.set(event.payload.questionSet, event.payload.answers.length);
      row.details = [...asked].map(([set, n]) => `${set} · ${n} ${n === 1 ? 'question' : 'questions'}`);
      row.calls += 1;
      row.cost += event.payload.costUsd;
      rows.set(key, row);
    }
  }
  const order = ['triage', 'planner', 'coder', 'reviewer', 'red-team'];
  return [...rows.values()].sort((a, b) => order.indexOf(a.agent) - order.indexOf(b.agent));
}

/** The checks on the latest commit that went through Gates. */
function gates(item: ItemState): GateRow[] {
  const started = [...item.events].reverse().find((event) => event.type === 'gates.started');
  if (started?.type !== 'gates.started') return [];
  const results = new Map<string, GateRow>();
  for (const event of item.events) {
    if (event.type === 'gate.finished' && event.payload.commit === started.payload.commit) {
      results.set(event.payload.check, {
        check: event.payload.check,
        conclusion: event.payload.conclusion,
        durationMs: event.payload.durationMs,
      });
    }
  }
  return started.payload.checks.flatMap((check) => results.get(check) ?? []);
}

/** How each sense is named in a sighting. */
const SENSE_ADDED: Record<string, (evidence: NonNullable<PayloadOf<'signal.received'>['evidence']>[number]) => string> =
  {
    logs: (e) => (e.kind === 'logs' ? `${e.lines.length} log ${e.lines.length === 1 ? 'line' : 'lines'}` : ''),
    metric: () => 'its series',
    http: (e) => (e.kind === 'http' ? `${e.method} ${e.url}, answered ${e.status ?? 'nothing'}` : ''),
    console: (e) => (e.kind === 'console' ? `${e.messages.length} console messages` : ''),
    accessibility: (e) =>
      e.kind === 'accessibility' ? `${e.findings.reduce((n, f) => n + f.elements.length, 0)} elements` : '',
  };

/** What a sense's signal added to the ticket, in a few words. */
function added(signal: PublicEvent<'signal.received'>): string | undefined {
  const [first] = signal.payload.evidence ?? [];
  const words = first ? SENSE_ADDED[first.kind]?.(first) : undefined;
  if (words) return `with ${words}`;
  return signal.artifacts.some((a) => a.kind === 'screenshot') ? 'with a screenshot' : undefined;
}

/** Every sense, those that saw the ticket's problem first and in the order they did, and the rest as not yet. */
function seenBy(item: ItemState): Sighting[] {
  const first = new Map<Sense, PublicEvent<'signal.received'>>();
  for (const event of item.events) {
    if (event.type === 'signal.received' && !first.has(event.payload.sense)) first.set(event.payload.sense, event);
  }
  const opener = [...first.values()][0];
  const seen = [...first.values()].map(
    (signal): Sighting => ({
      sense: signal.payload.sense,
      check: signal.payload.sense === 'report' ? 'A visitor’s report' : signal.payload.check,
      at: Date.parse(signal.ts),
      opened: signal === opener,
      added: signal === opener ? undefined : added(signal),
    }),
  );
  const unseen = SENSES.filter((sense) => !first.has(sense)).map(
    (sense): Sighting => ({ sense, check: undefined, at: undefined, opened: false, added: undefined }),
  );
  return [...seen, ...unseen];
}

/** Each sense's evidence for a ticket, the first time it saw the problem. */
function senseEvidence(item: ItemState): SenseEvidence[] {
  const seen = new Set<Sense>();
  return item.events.flatMap((event) => {
    if (event.type !== 'signal.received' || event.payload.sense === 'report' || seen.has(event.payload.sense))
      return [];
    seen.add(event.payload.sense);
    const picture = pictureOfSignal(event);
    return picture ? [{ sense: event.payload.sense, at: Date.parse(event.ts), picture }] : [];
  });
}

/** A symptom as the policy's table names it, for saying why no model was needed. */
const SYMPTOM_WORDS: Record<SymptomClass, string> = {
  'broken-link': 'a broken link',
  'broken-image': 'a broken image',
  'redirect-loop': 'a redirect loop',
  'wrong-result': 'a wrong result',
  'rejects-valid-input': 'refused valid input',
  'server-error': 'a server error',
  'browser-error': 'an error in the browser',
  'slow-response': 'a slow response',
  'not-cached': 'a file the browser may not keep',
  'missing-alt': 'an image without alternative text',
  'low-contrast': 'text too faint to read',
  'unlabelled-field': 'a field without a label',
  'missing-header': 'a missing security header',
  'leaks-detail': 'an error that gives the server away',
  'missing-log': 'a request with no log record',
  'wrong-metric': 'a metric with a wrong label',
};

/** A ticket's category, as a noun the sentence below can use. */
const CATEGORY_WORDS: Record<DefectCategory, string> = {
  content: 'a content problem',
  navigation: 'a navigation problem',
  functional: 'a functional problem',
  errors: 'an error',
  performance: 'a performance problem',
  accessibility: 'an accessibility problem',
  security: 'a security problem',
  observability: 'an observability problem',
};

/** Why no model was called, said as a sentence, for work that called none. */
function noModel(item: ItemState): string | undefined {
  if (item.calls > 0) return undefined;
  const fingerprint = item.ticket?.fingerprint;
  if (item.ticket && fingerprint && 'class' in fingerprint) {
    const { category, severity } = item.ticket;
    const next = item.queued ? ' The planner will be the first model this ticket meets.' : '';
    return `A sense knows what it saw, so the category and severity come from a table in the factory’s policy: ${SYMPTOM_WORDS[fingerprint.class]} is ${CATEGORY_WORDS[category]}, and ${severity}.${next}`;
  }
  return item.closedAt === undefined
    ? 'None yet: nothing so far has needed a model.'
    : 'None of this work needed a model.';
}

const where = (route: string) => (route === '*' ? 'every page' : route);

export function sheet(item: ItemState, events: readonly PublicEvent[], t: number): Sheet {
  const end = item.closedAt ?? t;
  const marks: { event: PublicEvent | undefined; label: string; tone: Chapter['tone'] }[] = item.events.flatMap(
    (event) => {
      const chapter = chapterOf(event, item);
      return chapter ? [{ event, ...chapter }] : [];
    },
  );
  // Work still on the line ends at now, or, for a ticket queued for the planner, waiting at Plan.
  if (item.closedAt === undefined) {
    marks.push(
      item.queued
        ? { event: undefined, label: 'WAITING · PLAN', tone: 'faint' }
        : { event: undefined, label: 'NOW', tone: 'signal' },
    );
  }
  const times = marks.map((m) => (m.event ? Date.parse(m.event.ts) : t));
  const positions = spread(times, item.openedAt, end);
  const chapters = marks.map(
    (m, i): Chapter => ({
      label: m.label,
      at: times[i] ?? t,
      actor: m.event?.actor,
      text: m.event ? m.event.summary : item.queued ? 'Waiting for the planner' : 'Still on the line',
      position: positions[i] ?? 100,
      site: [...item.captures].reverse().find((c) => c.at <= (times[i] ?? t) && c.side !== 'page'),
      tone: m.tone,
      ...(!m.event && item.queued && { waiting: true }),
    }),
  );

  const report = item.events.find((event) => event.type === 'signal.received' && event.payload.report);
  const verification = [...item.events].reverse().find((event) => event.type === 'verification.finished');
  const spec = [...item.events].reverse().find((event) => event.type === 'spec.written');
  const pushed = [...item.events].reverse().find((event) => event.type === 'pull-request.pushed');
  const shots = new Map(
    item.events.flatMap((event) =>
      event.artifacts.flatMap((artifact) => (artifact.kind === 'screenshot' ? [[artifact.hash, artifact]] : [])),
    ),
  );
  const humanLines = item.events
    .filter((event) => event.type === 'pull-request.pushed' && event.actor === 'martin')
    .reduce(
      (sum, event) =>
        sum +
        (event.type === 'pull-request.pushed' ? event.payload.files.reduce((n, f) => n + f.added + f.removed, 0) : 0),
      0,
    );

  return {
    card: card(item, events, t),
    report:
      report?.type === 'signal.received' && report.payload.report
        ? { page: report.payload.report.page, quarantined: item.outcome === 'quarantined' }
        : undefined,
    story: item.story ?? item.description ?? item.title,
    chapters,
    captures: item.captures.filter(
      (c) => c.side === 'broken' || c.side === 'canary' || c.side === 'fixed' || c.side === 'after',
    ),
    pages:
      verification?.type === 'verification.finished'
        ? {
            against: verification.payload.against,
            list: verification.payload.pages.map((page) => ({
              page: page.page,
              screenshot: shots.get(page.screenshot),
              changed: page.changed,
              intended: page.intended,
            })),
          }
        : undefined,
    spec: spec?.type === 'spec.written' ? spec.payload : undefined,
    files: pushed?.type === 'pull-request.pushed' ? pushed.payload.files : undefined,
    facts: {
      foundBy: foundBy(item),
      humanLines,
      ticket: item.ticket && {
        category: item.ticket.category,
        severity: item.ticket.severity,
        fingerprint:
          'class' in item.ticket.fingerprint
            ? `${where(item.ticket.fingerprint.route)} · ${item.ticket.fingerprint.class}`
            : `${item.ticket.fingerprint.page} · “${item.ticket.fingerprint.text}”`,
      },
    },
    seenBy: item.ticket ? seenBy(item) : undefined,
    senseEvidence: item.ticket ? senseEvidence(item) : [],
    agents: agents(item),
    noModel: noModel(item),
    gates: gates(item),
  };
}
