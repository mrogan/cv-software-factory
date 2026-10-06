/**
 * The reel at time t: one card per work item, oldest first, and the timeline under them.
 */
import type {
  Category,
  Evidence,
  Kind,
  PayloadOf,
  PublicEvent,
  Screenshot,
  Sense,
  Stage,
} from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import type { Capture, ItemState, Outcome } from './items.ts';

export type Segment = 'passed' | 'skipped' | 'now' | 'queued' | 'stopped' | 'waiting' | 'closed' | 'none';

export type Tag = 'BEFORE' | 'BROKEN' | 'FIXED' | 'AFTER' | 'NOW' | 'SEEN';

/**
 * The probability of holding instructions at which triage quarantines a report: `REPORTS.quarantine` in
 * policy/triage.ts. The console's image is built without policy/, so it keeps this copy, and a test holds the two
 * together.
 */
export const QUARANTINE_AT = 0.5;

type Http = Extract<Evidence, { kind: 'http' }>;
type Console = Extract<Evidence, { kind: 'console' }>;
type Accessibility = Extract<Evidence, { kind: 'accessibility' }>;
type Judgement = PayloadOf<'judgement.made'>;

/** Who captured a picture's evidence, with which check, on which version, and whether on one page or every page. */
export interface Source {
  sense: Sense;
  check: string;
  version: string;
  every: boolean;
}

/** The picture on a card: always evidence the factory captured, never an illustration. */
export type Picture =
  | { type: 'wipe'; before: Screenshot; after: Screenshot; tags: [Tag, Tag] }
  | { type: 'screenshot'; shot: Screenshot; tag: Tag }
  /** A metric over time: a fix's effect once verified, or, when `seen`, the problem as a sense saw it. */
  | { type: 'metric'; evidence: Extract<Evidence, { kind: 'metric' }>; unchanged: Screenshot[]; seen?: boolean }
  | {
      type: 'logs';
      before: Extract<Evidence, { kind: 'logs' }> | undefined;
      after: Extract<Evidence, { kind: 'logs' }>;
      seen?: boolean;
    }
  | {
      type: 'package';
      dependency: Dependency;
      files: PayloadOf<'pull-request.pushed'>['files'];
      checks: { passed: number; total: number } | undefined;
      unchanged: Screenshot[];
    }
  | { type: 'scan'; dependency: Dependency; findings: Findings; unchanged: Screenshot[] }
  | { type: 'rollback'; dependency: Dependency | undefined; rollback: PayloadOf<'release.rolled-back'> }
  | { type: 'refusal'; mechanism: string; output: string }
  | { type: 'judgement'; page: Screenshot | undefined; judgement: Judgement }
  /** A report quarantined: the answer that decided it, against its threshold, and no page at all. */
  | { type: 'quarantine'; judgement: Judgement }
  /** A visitor's suggestion, parked for Martin: the page it named and Jev's answers, waiting on him. */
  | { type: 'suggestion'; page: Screenshot | undefined; judgement: Judgement }
  | { type: 'spec'; spec: PayloadOf<'spec.written'>; question: string | undefined }
  /** A problem found on every page: a few of the pages, each marked, and how many more. */
  | { type: 'pages'; shots: Screenshot[]; more: number; source: Source }
  /** A request and what came back: what a screenshot cannot show, such as a redirect or a missing header. */
  | { type: 'http'; exchange: Http; source: Source }
  /** What the browser's console said, word for word, beside the page it said it on. */
  | { type: 'console'; console: Console; shot: Screenshot | undefined; source: Source }
  /** What an accessibility check found, with each element it named numbered on the screenshot. */
  | { type: 'accessibility'; findings: Accessibility; shot: Screenshot | undefined; source: Source }
  | { type: 'none' };

type Dependency = NonNullable<PayloadOf<'work-item.opened'>['dependency']>;
type Findings = NonNullable<PayloadOf<'gate.finished'>['findings']>;

export interface Versions {
  /** The version it broke or replaced. */
  from: string | undefined;
  /** The version it shipped, or is shipping. */
  to: string | undefined;
  rolledBack: boolean;
  /** Still on the canary: `to` is not yet live. */
  onCanary: boolean;
}

export interface Card {
  number: string;
  kind: Kind;
  /** A visitor started it. Which visitor is never public. */
  byVisitor: boolean;
  category: Category;
  outcome: Outcome;
  sample: boolean;
  title: string;
  description: string;
  picture: Picture;
  versions: Versions;
  /** The app's version when a sense first saw it, for work that has not reached a release. */
  seenOn: string | undefined;
  /** The page a visitor's report came from, at its path only. */
  from: string | undefined;
  /** Model calls and Jev requests: none at all is said as "no model". */
  calls: number;
  pullRequest: number | undefined;
  startedAt: number;
  /** Start to finish, or so far. */
  durationMs: number;
  spend: number;
  segments: Segment[];
  /** The version the shop was on once this item was done with it, or now if it is not. */
  shopVersion: string | undefined;
}

export interface Timeline {
  /** Where each card sits along the timeline, from 0 to 1, with a little space between days. */
  positions: number[];
  /** The first card of each day, and the day's start. */
  days: { index: number; day: number }[];
  /** The version each release left the shop on, struck through when it was rolled back. */
  versions: { index: number; version: string; rolledBack: boolean }[];
}

/** The segments under a card: how far the item got through the eight stages, and where it stopped. */
export function segments(item: ItemState): Segment[] {
  const current = item.stage ? STAGES.indexOf(item.stage) : -1;
  const entry = item.entry ? STAGES.indexOf(item.entry) : -1;
  return STAGES.map((stage, i): Segment => {
    if (current < 0 || i < entry) return entry < 0 && current < 0 ? 'none' : 'skipped';
    if (i < current) return item.visits[stage] ? 'passed' : 'skipped';
    if (i > current) return 'none';
    switch (item.outcome) {
      case 'verified':
        return 'passed';
      case 'rolled-back':
      case 'held':
        return 'stopped';
      case 'needs-you':
        return 'waiting';
      case 'waiting':
        return 'queued';
      case 'closed':
      case 'quarantined':
      case 'no-ticket':
        return item.failure ? 'stopped' : 'closed';
      default:
        return 'now';
    }
  });
}

/** Where the item got to, in words, for the segments' accessible name. */
export function segmentsLabel(list: readonly Segment[]): string {
  const at = list.findIndex(
    (s) => s === 'now' || s === 'queued' || s === 'stopped' || s === 'waiting' || s === 'closed',
  );
  if (at < 0) return list.every((s) => s === 'none') ? 'Not on the line yet' : 'Every stage passed';
  const stage = STAGES[at] as Stage;
  const name = stage[0]?.toUpperCase() + stage.slice(1);
  return {
    now: `Now at ${name}`,
    queued: stage === 'plan' ? 'Waiting at Plan for the planner' : `Waiting at ${name}`,
    stopped: `Stopped at ${name}`,
    waiting: `Waiting at ${name}`,
    closed: `Closed at ${name}`,
  }[list[at] as 'now' | 'queued' | 'stopped' | 'waiting' | 'closed'];
}

const last = <T>(list: readonly T[], test: (value: T) => boolean) => [...list].reverse().find(test);

const ofType = <K extends PublicEvent['type']>(item: ItemState, type: K) =>
  item.events.filter((event): event is PublicEvent<K> => event.type === type);

const MECHANISMS: Record<PayloadOf<'action.refused'>['mechanism'], string> = {
  'token-permission': 'Token permissions',
  ruleset: 'The ruleset on main',
  'egress-policy': 'The egress policy',
  'admission-control': 'Admission control',
  'scope-fence': 'The scope fence',
};

/** The pages verification found unchanged, for the strip under a picture of something with nothing to see. */
function unchangedPages(item: ItemState): Screenshot[] {
  const verification = last(ofType(item, 'verification.finished'), () => true);
  if (!verification) return [];
  const shots = new Map(verification.artifacts.flatMap((a) => (a.kind === 'screenshot' ? [[a.hash, a]] : [])));
  return verification.payload.pages.flatMap((page) => {
    const shot = shots.get(page.screenshot);
    return page.changed === 0 && shot ? [shot] : [];
  });
}

/** The picture for a card: the evidence that best shows what changed. */
export function picture(item: ItemState): Picture {
  const rolledBack = last(ofType(item, 'release.rolled-back'), () => true);
  if (rolledBack) return { type: 'rollback', dependency: item.dependency, rollback: rolledBack.payload };

  if (item.kind === 'red-team') {
    const refused = last(ofType(item, 'action.refused'), () => true);
    if (refused)
      return { type: 'refusal', mechanism: MECHANISMS[refused.payload.mechanism], output: refused.payload.output };
    const gate = last(ofType(item, 'gate.finished'), (event) => event.payload.conclusion === 'failure');
    if (gate?.payload.output) return { type: 'refusal', mechanism: gate.payload.check, output: gate.payload.output };
  }

  // A report shows what triage made of it: the request that routed it, which is its first. One that ended at triage
  // shows it for good; one that became a ticket only until the line has evidence of its own, such as a fix.
  const judgement = ofType(item, 'judgement.made').find((event) => event.payload.route)?.payload;
  const endedAtTriage =
    judgement?.route === 'quarantine' || judgement?.route === 'park' || judgement?.route === 'discard';
  const pastPlan = item.stage !== null && STAGES.indexOf(item.stage) > STAGES.indexOf('plan');
  if (item.kind === 'visitor-report' && judgement && (endedAtTriage || !pastPlan)) {
    const page = capture(item, 'page')?.shot;
    if (judgement.route === 'quarantine') return { type: 'quarantine', judgement };
    if (judgement.route === 'park') return { type: 'suggestion', page, judgement };
    return { type: 'judgement', page, judgement };
  }

  const spec = last(ofType(item, 'spec.written'), () => true);
  if (item.outcome === 'needs-you' && spec) return { type: 'spec', spec: spec.payload, question: item.hold?.question };

  if (item.dependency) {
    const findings = last(ofType(item, 'gate.finished'), (event) => Boolean(event.payload.findings))?.payload.findings;
    if (item.dependency.security && findings) {
      return { type: 'scan', dependency: item.dependency, findings, unchanged: unchangedPages(item) };
    }
    const gates = last(ofType(item, 'gates.finished'), () => true)?.payload;
    return {
      type: 'package',
      dependency: item.dependency,
      files: last(ofType(item, 'pull-request.pushed'), () => true)?.payload.files ?? [],
      checks: gates && { passed: gates.passed, total: gates.passed + gates.failed.length },
      unchanged: unchangedPages(item),
    };
  }

  const wipe = wipeOf(item);
  if (wipe) return wipe;

  const { signal, verified } = item.evidence;
  if (verified?.kind === 'metric') return { type: 'metric', evidence: verified, unchanged: unchangedPages(item) };
  if (verified?.kind === 'logs') {
    return { type: 'logs', before: signal?.kind === 'logs' ? signal : undefined, after: verified };
  }
  if (signal?.kind === 'metric') return { type: 'metric', evidence: signal, unchanged: [], seen: true };

  const opened = opening(item);
  const seen = opened && pictureOfSignal(opened);
  if (seen) return seen;

  const broken = capture(item, 'broken');
  if (broken) return { type: 'screenshot', shot: broken.shot, tag: 'SEEN' };
  if (spec) return { type: 'spec', spec: spec.payload, question: item.hold?.question };
  return { type: 'none' };
}

/** The sense's signal that opened the work item, if a sense opened it. */
const opening = (item: ItemState) => ofType(item, 'signal.received').find((event) => event.payload.sense !== 'report');

/**
 * The picture a sense's own capture makes: a screenshot where it marked something on the page, and otherwise what
 * the sense recorded instead (every page, the browser's console, an accessibility check, an HTTP exchange, a metric
 * or log lines), or the unmarked page.
 */
export function pictureOfSignal(signal: PublicEvent<'signal.received'>): Picture | undefined {
  const { sense, check, version, route, evidence = [] } = signal.payload;
  const source: Source = { sense, check, version, every: route === '*' };
  const shots = signal.artifacts.filter((a): a is Screenshot => a.kind === 'screenshot');
  const find = <K extends Evidence['kind']>(kind: K) =>
    evidence.find((e): e is Extract<Evidence, { kind: K }> => e.kind === kind);
  const [shot] = shots;
  if (source.every && shots.length > 1) {
    return { type: 'pages', shots: shots.slice(0, 4), more: Math.max(0, shots.length - 4), source };
  }
  if (shot?.boxes.length) return { type: 'screenshot', shot, tag: 'SEEN' };
  const consoled = find('console');
  if (consoled) return { type: 'console', console: consoled, shot, source };
  const accessibility = find('accessibility');
  if (accessibility) return { type: 'accessibility', findings: accessibility, shot, source };
  const http = find('http');
  if (http) return { type: 'http', exchange: http, source };
  const metric = find('metric');
  if (metric) return { type: 'metric', evidence: metric, unchanged: [], seen: true };
  const logs = find('logs');
  if (logs) return { type: 'logs', before: undefined, after: logs, seen: true };
  if (shot) return { type: 'screenshot', shot, tag: 'SEEN' };
  return undefined;
}

const capture = (item: ItemState, side: Capture['side']) => last(item.captures, (c) => c.side === side);

/** Before and after, when the factory captured both: the problem and its fix, or the page before and now. */
function wipeOf(item: ItemState): Picture | undefined {
  const before = item.captures.find((c) => c.side === 'before');
  const broken = item.captures.find((c) => c.side === 'broken');
  const after = capture(item, 'fixed') ?? capture(item, 'after');
  if (after && broken) return { type: 'wipe', before: broken.shot, after: after.shot, tags: ['BROKEN', 'FIXED'] };
  if (after && before) return { type: 'wipe', before: before.shot, after: after.shot, tags: ['BEFORE', 'AFTER'] };
  if (before && broken) return { type: 'wipe', before: before.shot, after: broken.shot, tags: ['BEFORE', 'NOW'] };
  return undefined;
}

/** The version the shop was on at a time: the last one promoted, injected or restored by then. */
export function shopVersion(events: readonly PublicEvent[], at: number): string | undefined {
  let version: string | undefined;
  for (const event of events) {
    if (Date.parse(event.ts) > at) break;
    if (event.type === 'release.promoted' || event.type === 'defect.injected') version = event.payload.version;
    if (event.type === 'release.rolled-back') version = event.payload.restored;
    if (event.type === 'release.started' && !version) version = event.payload.previous;
  }
  return version;
}

export function card(item: ItemState, events: readonly PublicEvent[], t: number): Card {
  const end = item.closedAt ?? t;
  return {
    number: item.number,
    kind: item.kind,
    byVisitor: item.openedBy === 'visitor',
    category: item.category,
    outcome: item.outcome,
    sample: item.sample,
    title: item.title,
    description: item.description ?? last(item.events, (e) => e.type !== 'model.called')?.summary ?? '',
    picture: picture(item),
    versions: {
      from: item.versions.from,
      to: item.versions.to,
      rolledBack: item.versions.rolledBack,
      onCanary: Boolean(item.canary),
    },
    seenOn: item.seenOn,
    from: item.reportPage,
    calls: item.calls,
    pullRequest: item.pullRequest,
    startedAt: item.openedAt,
    durationMs: Math.max(0, end - item.openedAt),
    spend: item.spend,
    segments: segments(item),
    shopVersion: shopVersion(events, end),
  };
}

/** Days are told apart by where the viewer is: a new day starts at their midnight. */
const dayOf = (at: number) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

export function timeline(cards: readonly Card[]): Timeline {
  const days: Timeline['days'] = [];
  const units = cards.map((c, i) => {
    const day = dayOf(c.startedAt);
    if (days.at(-1)?.day !== day) days.push({ index: i, day });
    // Half a card's width between days.
    return i + (days.length - 1) * 0.5;
  });
  const span = units.at(-1) || 1;
  return {
    positions: units.map((u) => (cards.length > 1 ? u / span : 0.5)),
    days,
    versions: cards.flatMap((c, index) =>
      c.versions.to && (c.outcome === 'verified' || c.outcome === 'rolled-back')
        ? [{ index, version: c.versions.to, rolledBack: c.versions.rolledBack }]
        : [],
    ),
  };
}
