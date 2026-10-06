/**
 * The events triage writes for each outcome, with summaries from templates over typed fields. A report's text is
 * never in a summary, a title or a story: those are public.
 *
 * Every event's id is derived from the signal's id in the inbox, so triage taking the same signal again after a
 * crash appends nothing twice (the store stores an event appended again once).
 */
import { createHash } from 'node:crypto';
import {
  type EventType,
  type InboxSignal,
  type NewEvent,
  type PayloadOf,
  type Sense,
  type SymptomClass,
  VERSIONS,
} from '@software-factory/events';
import { SYMPTOMS } from '../../../policy/triage.ts';
import type { Fingerprint, Judgement, ReportDecision } from './reports.ts';
import { privatePath, shortPath } from './scrub.ts';

/** Ids for the events made from one signal: the same signal always gives the same ids, in the same order. */
export function idsFor(signalId: string): () => string {
  let n = 0;
  return () => {
    const h = createHash('sha256').update(`triage:${signalId}:${n++}`).digest('hex').slice(0, 32).split('');
    // A version 8 UUID, for a custom scheme, with the RFC 9562 variant.
    h[12] = '8';
    h[16] = ((Number.parseInt(h[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  };
}

/** Writes a work item's events in order, with ids from the signal and one time for all of them. */
class Writer {
  readonly events: NewEvent[] = [];
  readonly #id: () => string;
  readonly #item: string;
  readonly #ts: string;

  constructor(signalId: string, workItem: string, now: Date) {
    this.#id = idsFor(signalId);
    this.#item = workItem;
    this.#ts = now.toISOString();
  }

  add<K extends EventType>(
    type: K,
    actor: NewEvent<K>['actor'],
    summary: string,
    payload: PayloadOf<K>,
    artifacts: NewEvent<K>['artifacts'] = [],
  ): this {
    this.events.push({
      id: this.#id(),
      ts: this.#ts,
      work_item: this.#item,
      type,
      version: VERSIONS[type],
      actor,
      summary,
      payload,
      artifacts,
    } as NewEvent);
    return this;
  }
}

const SENSE_NAMES: Record<Exclude<Sense, 'report'>, string> = {
  probe: 'The probes',
  crawler: 'The crawler',
  metrics: 'The metrics',
  logs: 'The log watcher',
};

/** A ticket's title, from what was seen and where. */
const TITLES: Record<SymptomClass, string> = {
  'broken-link': 'A link leads nowhere',
  'broken-image': 'An image does not load',
  'redirect-loop': 'A page redirects without end',
  'wrong-result': 'A wrong result',
  'rejects-valid-input': 'Valid input is refused',
  'server-error': 'Server errors',
  'browser-error': 'Errors in the browser',
  'slow-response': 'Slow responses',
  'not-cached': 'Files the browser may not keep',
  'missing-alt': 'Images without alternative text',
  'low-contrast': 'Text too faint to read',
  'unlabelled-field': 'A form field without a label',
  'missing-header': 'A security header is missing',
  'leaks-detail': 'Errors give away the server’s insides',
  'missing-log': 'Requests leave no log record',
  'wrong-metric': 'Metrics with a wrong label',
};

const where = (route: string) => (route === '*' ? 'every page' : shortPath(route));

export const ticketTitle = (fingerprint: Fingerprint): string =>
  'class' in fingerprint
    ? `${TITLES[fingerprint.class]} on ${where(fingerprint.route)}`
    : `Wrong words on ${shortPath(fingerprint.page)}`;

/** A report's ticket says a visitor raised it. Its title is the factory's words, never the visitor's. */
export const reportedTitle = (fingerprint: Fingerprint): string => {
  const title = ticketTitle(fingerprint);
  return `A visitor reports ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
};

/** Trace ids in the signal's evidence, so the planner can follow a failing request. */
function tracesOf(signal: InboxSignal): string[] {
  const ids = (signal.evidence ?? []).flatMap((evidence) =>
    evidence.kind === 'logs'
      ? [...(evidence.trace ? [evidence.trace.id] : []), ...evidence.lines.flatMap((line) => line.traceId ?? [])]
      : [],
  );
  return [...new Set(ids)].slice(0, 10);
}

/** The signal as an event of the work item, with its own artifacts. */
function signalEvent(writer: Writer, signal: InboxSignal): Writer {
  const { observedAt: _at, summary, artifacts, ...payload } = signal;
  const actor = signal.sense === 'report' ? 'widget' : signal.sense;
  const line =
    signal.sense === 'report'
      ? `A visitor reported a problem on ${shortPath(payload.report?.page ?? payload.route)}`
      : (summary ?? `${signal.check}: ${TITLES[signal.symptom as SymptomClass].toLowerCase()}`);
  return writer.add('signal.received', actor, line, payload, artifacts);
}

/** A sense's signal with a fingerprint no open ticket has: a new work item with its ticket, waiting for Plan. */
export function senseTicket(signal: InboxSignal, signalId: string, workItem: string, now: Date): NewEvent[] {
  const symptom = signal.symptom as SymptomClass;
  const { category, severity } = SYMPTOMS[symptom];
  const fingerprint = { route: signal.route, class: symptom };
  const title = ticketTitle(fingerprint);
  const sense = SENSE_NAMES[signal.sense as Exclude<Sense, 'report'>];
  const writer = new Writer(signalId, workItem, now);
  writer.add('work-item.opened', 'triage', `${sense} opened a work item`, {
    kind: 'defect-fix',
    title,
    sample: false,
    category,
  });
  signalEvent(writer, signal);
  writer.add('ticket.opened', 'triage', `Ticket #${workItem}: ${category}, ${severity}`, {
    title,
    category,
    severity,
    fingerprint,
    traces: tracesOf(signal),
  });
  return writer.add('work-item.summarised', 'triage', 'Summary written', {
    title,
    description: `${sense} found it: ${signal.check}. Triage opened a ticket, ${category} and ${severity}, which waits for the planner.`,
    story: `${sense} found it on ${where(signal.route)} in version ${signal.version}, on two checks in a row: ${signal.check}. A sense knows what it saw, so the ticket’s category and severity come from the policy’s table for the symptom, not from a model. Triage opened ticket #${workItem} with the evidence the sense captured. Nothing has been fixed yet: the ticket waits at Plan.`,
  }).events;
}

/** A sense's signal on an open ticket, the first time this sense has seen it: its evidence joins the ticket. */
export function senseEvidence(signal: InboxSignal, signalId: string, workItem: string, now: Date): NewEvent[] {
  return signalEvent(new Writer(signalId, workItem, now), signal).events;
}

const QUARANTINED = 'The report holds instructions aimed at the system, so nothing acts on it';

/** Every report becomes events, because whoever sent it is owed an answer. */
export function reportEvents(
  signal: InboxSignal,
  signalId: string,
  workItem: string,
  decision: ReportDecision,
  now: Date,
): NewEvent[] {
  const { routed, judgements } = decision;
  // The page without its query or anything private in its path: the visitor may have typed either.
  const path = privatePath(signal.report?.page ?? signal.route);
  const page = shortPath(path);
  const scrubbed = { ...signal, route: privatePath(signal.route), report: { page: path, text: decision.text } };
  const shot = decision.screenshot ? [decision.screenshot] : [];
  const writer = new Writer(signalId, workItem, now);
  if (routed.route !== 'repeat') {
    writer.add('work-item.opened', 'visitor', `A visitor sent a report from ${page}`, {
      kind: 'visitor-report',
      title: `A report from ${page}`,
      sample: false,
      ...(CARD_CATEGORY[routed.route] && { category: CARD_CATEGORY[routed.route] }),
    });
  }
  signalEvent(writer, { ...scrubbed, artifacts: [...scrubbed.artifacts, ...shot] });
  for (const judgement of judgements) writer.add('judgement.made', 'triage', judgementLine(judgement), judgement);

  switch (routed.route) {
    case 'quarantine':
      writer.add('work-item.closed', 'triage', 'Quarantined: the report gives orders to the system', {
        outcome: 'quarantined',
        reason: QUARANTINED,
      });
      return summarise(writer, {
        title: 'A report that gave orders',
        description:
          'Jev read it as instructions aimed at the system, so triage quarantined it. No ticket, and no agent ever reads it.',
        story: `A visitor sent a report from ${page}. Report text is untrusted, so it went to Jev as data, and Jev can only answer the questions it is asked. It judged that the report holds instructions aimed at the system, and routing code quarantined it before anything else. It is kept as evidence; no generative agent ever reads it.`,
      });
    case 'park':
      writer.add('hold.started', 'triage', 'Waiting for Martin: a visitor suggested a change', {
        stage: 'triage',
        kind: 'approval',
        cause: 'suggestion',
        reason:
          'A visitor asked for something new, and only Martin asks for improvements: it waits for Martin to decide.',
      });
      return summarise(writer, {
        title: 'A visitor’s suggestion',
        description:
          'Jev read it as a request for something new, not a fault. Triage parked it for Martin, who alone asks for improvements.',
        story: `A visitor sent a report from ${page}. Jev judged it a suggestion: a request for new behaviour rather than a fault. Only Martin can ask for an improvement, so routing code parked it for Martin instead of opening a ticket.`,
      });
    case 'discard':
      writer.add('work-item.closed', 'triage', 'Closed with no ticket: not a defect', {
        outcome: 'discarded',
        reason: 'Jev found nothing wrong with the page in it',
      });
      return summarise(writer, {
        title: `A report from ${page} that was not a defect`,
        description: 'Triage read the report against the page and found nothing wrong. No ticket, nothing built.',
        story: `A visitor sent a report from ${page}. It went to Jev as data, and Jev judged that it describes nothing wrong with the site. Routing code closed it with no ticket. The report is kept, where only Martin and its sender can read it.`,
      });
    case 'repeat':
      return writer.events;
    case 'ticket': {
      const fingerprint = decision.fingerprint as Fingerprint;
      const title = reportedTitle(fingerprint);
      writer.add('ticket.opened', 'triage', `Ticket #${workItem}: ${routed.category}, ${routed.severity}`, {
        title,
        category: routed.category,
        severity: routed.severity,
        fingerprint,
        traces: [],
      });
      return summarise(writer, {
        title,
        description: `A visitor reported it. Jev judged it ${routed.category} and ${routed.severity}; triage opened a ticket, which waits for the planner.`,
        story: `A visitor sent a report from ${page}. It went to Jev as data, and Jev judged it a ${routed.category} problem, ${routed.severity} for a visitor, with no instructions for the system in it. Triage opened ticket #${workItem} with a screenshot of the page, taken by the factory. The ticket holds Jev’s typed answers and the factory’s own evidence, never the visitor’s words.`,
      });
    }
  }
}

const CARD_CATEGORY: Partial<Record<ReportDecision['routed']['route'], 'red-team' | 'improvement' | 'not-a-defect'>> = {
  quarantine: 'red-team',
  park: 'improvement',
  discard: 'not-a-defect',
};

const summarise = (writer: Writer, summary: PayloadOf<'work-item.summarised'>) =>
  writer.add('work-item.summarised', 'triage', 'Summary written', summary).events;

/** "Triage: functional (0.97), broken, no instructions (0.01)", from the answers alone. */
export function judgementLine(judgement: Judgement): string {
  const by = new Map(judgement.answers.map((a) => [a.key, a]));
  const parts: string[] = [];
  const category = by.get('category');
  if (category?.type === 'choice') {
    parts.push(`${category.answer.replaceAll('-', ' ')} (${p(category.probabilities[category.answer])})`);
  }
  const severity = by.get('severity');
  if (severity?.type === 'score') {
    parts.push(severity.levels[Math.round(severity.expected)] ?? `${severity.expected.toFixed(2)}`);
  }
  const injection = by.get('injection');
  if (injection?.type === 'noul') {
    parts.push(`${injection.probability >= 0.5 ? 'instructions' : 'no instructions'} (${p(injection.probability)})`);
  }
  const passage = by.get('passage');
  if (passage?.type === 'choice') parts.push(`passage chosen (${p(passage.probabilities[passage.answer])})`);
  return `Triage: ${parts.join(', ')}`;
}

const p = (value: number | undefined) => (value ?? 0).toFixed(2);
