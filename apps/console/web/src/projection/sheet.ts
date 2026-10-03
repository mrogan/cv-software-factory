/**
 * One work item in full, at time t: what happened, a chapter per step through the line with the site as it was
 * at each, the evidence, the change, the facts, the agents and models, and the gates.
 */
import type { Kind, PayloadOf, PublicEvent, Screenshot, Sense } from '@software-factory/events';
import type { Capture, ItemState } from './items.ts';
import { type Card, card } from './reel.ts';

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
}

export interface AgentRow {
  agent: string;
  provider: 'anthropic' | 'typesafe';
  model: string;
  settings: string;
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

export interface Sheet {
  card: Card;
  /** A visitor's report: shown as withheld here, since only Martin and its author may read its text. */
  report: { page: string } | undefined;
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
  };
  agents: AgentRow[];
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
      return event.payload.outcome === 'no-change' ? { label: 'CLOSED', tone: 'faint' } : undefined;
    default:
      return undefined;
  }
}

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
  for (const event of item.events) {
    if (event.type === 'model.called') {
      const { agent, model, settings, tokens, costUsd } = event.payload;
      const key = `${agent}/${model}`;
      const row = rows.get(key) ?? {
        agent,
        provider: 'anthropic',
        model,
        settings: SETTINGS(settings),
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      };
      row.calls += 1;
      row.tokensIn += tokens.input + tokens.cacheRead + tokens.cacheWrite;
      row.tokensOut += tokens.output;
      row.cost += costUsd;
      rows.set(key, row);
    } else if (event.type === 'judgement.made') {
      const key = `triage/${event.payload.model}`;
      const row = rows.get(key) ?? {
        agent: 'triage',
        provider: 'typesafe',
        model: event.payload.model,
        settings: `${event.payload.questionSet} · ${event.payload.answers.length} questions`,
        calls: 0,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
      };
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

export function sheet(item: ItemState, events: readonly PublicEvent[], t: number): Sheet {
  const end = item.closedAt ?? t;
  const marks: { event: PublicEvent | undefined; label: string; tone: Chapter['tone'] }[] = item.events.flatMap(
    (event) => {
      const chapter = chapterOf(event, item);
      return chapter ? [{ event, ...chapter }] : [];
    },
  );
  // Work still on the line ends at now.
  if (item.closedAt === undefined) marks.push({ event: undefined, label: 'NOW', tone: 'signal' });
  const times = marks.map((m) => (m.event ? Date.parse(m.event.ts) : t));
  const positions = spread(times, item.openedAt, end);
  const chapters = marks.map(
    (m, i): Chapter => ({
      label: m.label,
      at: times[i] ?? t,
      actor: m.event?.actor,
      text: m.event ? m.event.summary : 'Still on the line',
      position: positions[i] ?? 100,
      site: [...item.captures].reverse().find((c) => c.at <= (times[i] ?? t) && c.side !== 'page'),
      tone: m.tone,
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
      report?.type === 'signal.received' && report.payload.report ? { page: report.payload.report.page } : undefined,
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
    facts: { foundBy: foundBy(item), humanLines },
    agents: agents(item),
    gates: gates(item),
  };
}
