/**
 * Public views: what anyone but Martin may see of an event. Each type defines its own, and the compiler refuses a
 * type without one. The store writes the view once, when the event is appended, and the console serves only views.
 *
 * Every view leaves out what a visitor wrote (a report's text, and the query of the page it came from) and their
 * key, and redacts anything shaped like a secret, because some fields (a gate's output, a log line) are copied
 * verbatim from places the factory does not control.
 */
import type { View } from './types.ts';
import type { EventType } from './versions.ts';

type Rule = [pattern: RegExp, replacement: string];

/** Shapes of credentials that must never be published, even where a check's output prints one by mistake. */
const SECRET_SHAPES: Rule[] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[\w-]{8,}/g, '[redacted]'],
  [/\bsk-[\w-]{20,}/g, '[redacted]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, '[redacted]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[redacted]'],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted]'],
  [/\b(Bearer|Basic) +[\w.~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[redacted]@'],
  [
    /\b([\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key))(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
    '$1$2[redacted]',
  ],
];

/** Replaces anything secret-shaped in a string. */
export function redactSecrets(text: string): string {
  return SECRET_SHAPES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

/** Redacts every string in a value, keeping its shape. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)])) as T;
  }
  return value;
}

type PublicViewOf<K extends EventType> = (event: View<K>) => View<K>;

/** The page a report came from, without its query: a query is typed by the visitor, so it is theirs, like the text. */
const pathOf = (page: string) => page.split(/[?#]/)[0] || '/';

/** The view of an event with nothing to leave out but secrets. */
const redacted = <K extends EventType>(event: View<K>): View<K> => redactDeep(event);

export const PUBLIC_VIEWS = {
  'work-item.opened': ({ payload: { visitor: _key, ...payload }, ...event }) => redacted({ ...event, payload }),
  'work-item.summarised': redacted,
  'work-item.closed': redacted,
  'defect.injected': redacted,
  'attack.launched': redacted,
  'signal.received': (event) => {
    const { report, ...payload } = event.payload;
    if (!report) return redacted(event);
    // A report's summary is replaced as well as its text, so a careless summary cannot quote the report. A planner's
    // finding is kept as close: its words are untrusted too.
    const summary =
      payload.sense === 'planner'
        ? `The planner noted something on ${pathOf(report.page)}`
        : `A visitor reported a problem on ${pathOf(report.page)}`;
    return redacted({
      ...event,
      summary,
      payload: { ...payload, report: { page: pathOf(report.page) } },
    });
  },
  'judgement.made': (event) => {
    const { report, ...state } = event.payload.state;
    return redacted({
      ...event,
      payload: { ...event.payload, state: { ...state, ...(report && { report: { page: pathOf(report.page) } }) } },
    });
  },
  'ticket.opened': redacted,
  'spec.written': redacted,
  'pull-request.pushed': redacted,
  'gates.started': redacted,
  'gate.finished': redacted,
  'gates.finished': redacted,
  'review.submitted': redacted,
  'pull-request.merged': redacted,
  'release.started': redacted,
  'canary.stepped': redacted,
  'release.promoted': redacted,
  'release.rolled-back': redacted,
  'verification.finished': redacted,
  'work.returned': redacted,
  'hold.started': redacted,
  'hold.answered': redacted,
  'action.refused': redacted,
  'model.called': redacted,
  'line.started': redacted,
  'line.stopped': redacted,
  'spend.capped': redacted,
  'spend.cleared': redacted,
} satisfies { [K in EventType]: PublicViewOf<K> };

/** The public view of an event. Applying it twice changes nothing. */
export function publicView<K extends EventType>(type: K, event: View<K>): View<K> {
  return (PUBLIC_VIEWS[type] as PublicViewOf<K>)(event);
}
