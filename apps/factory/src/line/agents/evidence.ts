/**
 * What the senses saw, as an agent's prompt tells it: each signal by its typed fields, one line per piece of
 * evidence. An agent reads a ticket's evidence through this module, so every agent sees it alike.
 *
 * Never a visitor's words. A visitor's report is left out whole, by the type and by the line, which never reads a
 * report's signal. A log line is the one piece of evidence that can carry what a visitor typed: an app may log the
 * path or the query it was sent, in the line or in the exception it attaches, quoted or not. Taking the varying parts
 * out (the log watcher's `reduce`) leaves unquoted words standing, so no log message reaches a prompt at all: a log
 * signal is told by its route, how many requests it covers and how many lines it holds at each level, and its trace
 * by its id and timings. Every route an agent is told is cut at its query. Everything else the senses keep is the
 * app's answer to a request the sense made itself.
 */
import type { PayloadOf } from '@software-factory/events';
import { count } from './agent.ts';

/** A sense's signal as an agent sees it: everything but a visitor's report. */
export type Signal = Omit<PayloadOf<'signal.received'>, 'report'>;
type Evidence = NonNullable<Signal['evidence']>[number];

/** A route without its query or fragment, which a route never needs and a visitor may have typed. */
export const routeOf = (route: string) => route.split(/[?#]/)[0] || '/';

/** Where the ticket is, as triage fingerprinted it, and how it was classed, with its traces if it has any. */
export function ticketLines(ticket: PayloadOf<'ticket.opened'>): string[] {
  const { fingerprint } = ticket;
  const where =
    'class' in fingerprint
      ? `It is a ${fingerprint.class} on ${fingerprint.route === '*' ? 'every page the senses checked' : routeOf(fingerprint.route)}.`
      : `It is about the words "${fingerprint.text}" on ${routeOf(fingerprint.page)}, as the factory read the page.`;
  return [
    `${where} Category ${ticket.category}, severity ${ticket.severity}.`,
    ...(ticket.traces.length ? [`Its traces: ${ticket.traces.join(', ')}.`] : []),
  ];
}

const SENSE: Record<Signal['sense'], string> = {
  probe: 'A probe',
  crawler: 'The crawler',
  metrics: 'The metrics',
  logs: 'The log watcher',
  report: 'A report',
};

const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

/** One piece of evidence, as lines of the prompt. */
export function evidenceLines(evidence: Evidence): string[] {
  switch (evidence.kind) {
    case 'http': {
      const headers = Object.entries(evidence.headers).map(([name, value]) => `${name}: ${value ?? '(absent)'}`);
      return [
        `${evidence.method} ${evidence.url} answered ${evidence.status ?? 'nothing'} in ${evidence.timings.totalMs} ms`,
        ...evidence.redirects.map((r) => `  redirected ${r.status} to ${r.location}`),
        ...(headers.length ? [`  headers: ${headers.join('; ')}`] : []),
      ];
    }
    case 'console':
      return evidence.messages.map(
        (m) =>
          `the browser's console on ${routeOf(evidence.route)}, ${m.level}: ${m.text}${m.source ? ` (${m.source})` : ''}`,
      );
    case 'accessibility':
      return evidence.findings.map(
        (f) =>
          `axe's ${f.rule} (${f.impact}) on ${routeOf(evidence.route)}: ${f.help}; at ${f.elements.map((e) => e.selector).join(', ')}`,
      );
    case 'metric': {
      const values = evidence.values.filter((v): v is number => v !== null);
      const range = values.length
        ? `from ${Math.min(...values)} to ${Math.max(...values)}, lately ${values.at(-1)}`
        : 'no values';
      const objective = evidence.objective === undefined ? '' : `, against an objective of ${evidence.objective}`;
      return [`${evidence.name} in ${evidence.unit}: ${range}${objective}`];
    }
    case 'logs': {
      const levels = LEVELS.flatMap((level) => {
        const n = evidence.lines.filter((l) => l.level === level).length;
        return n ? [`${count(n, 'line')} at ${level}`] : [];
      });
      const { trace } = evidence;
      const longest = trace?.spans.length ? Math.max(...trace.spans.map((s) => s.durationMs)) : 0;
      return [
        `${count(evidence.requests, 'request')} to ${routeOf(evidence.route)} logged ${levels.join(', ') || 'nothing'}`,
        ...(trace ? [`  trace ${trace.id}: ${trace.spans.length} spans, the longest ${longest} ms`] : []),
      ];
    }
  }
}

/** A sense's signal, as lines of a prompt: what it checked and where, then each piece of its evidence. */
export function seen(signal: Signal): string[] {
  const symptom = signal.symptom ? `, ${signal.symptom}` : '';
  const where = signal.route === '*' ? 'every page' : routeOf(signal.route);
  return [
    `- ${SENSE[signal.sense]}'s check "${signal.check}" on ${where} in version ${signal.version}${symptom}`,
    ...(signal.evidence ?? []).flatMap(evidenceLines).map((line) => `  - ${line}`),
  ];
}
