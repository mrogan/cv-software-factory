/**
 * The reel at time t: one card per work item, oldest first, and the timeline under them.
 */
import type { Category, Evidence, Kind, PayloadOf, PublicEvent, Screenshot, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import type { Capture, ItemState, Outcome } from './items.ts';

export type Segment = 'passed' | 'skipped' | 'now' | 'stopped' | 'waiting' | 'closed' | 'none';

export type Tag = 'BEFORE' | 'BROKEN' | 'FIXED' | 'AFTER' | 'NOW';

/** The picture on a card: always evidence the factory captured, never an illustration. */
export type Picture =
  | { type: 'wipe'; before: Screenshot; after: Screenshot; tags: [Tag, Tag] }
  | { type: 'screenshot'; shot: Screenshot; tag: Tag }
  | { type: 'metric'; evidence: Extract<Evidence, { kind: 'metric' }>; unchanged: number }
  | {
      type: 'logs';
      before: Extract<Evidence, { kind: 'logs' }> | undefined;
      after: Extract<Evidence, { kind: 'logs' }>;
    }
  | { type: 'package'; dependency: Dependency; unchanged: number }
  | { type: 'scan'; dependency: Dependency; findings: Findings; unchanged: number }
  | { type: 'rollback'; dependency: Dependency | undefined; rollback: PayloadOf<'release.rolled-back'> }
  | { type: 'refusal'; mechanism: string; output: string }
  | { type: 'judgement'; page: Screenshot | undefined; judgement: PayloadOf<'judgement.made'> }
  | { type: 'spec'; spec: PayloadOf<'spec.written'>; question: string | undefined }
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
  category: Category;
  outcome: Outcome;
  sample: boolean;
  title: string;
  description: string;
  picture: Picture;
  versions: Versions;
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
      case 'closed':
        return item.failure ? 'stopped' : 'closed';
      default:
        return 'now';
    }
  });
}

/** Where the item got to, in words, for the segments' accessible name. */
export function segmentsLabel(list: readonly Segment[]): string {
  const at = list.findIndex((s) => s === 'now' || s === 'stopped' || s === 'waiting' || s === 'closed');
  if (at < 0) return list.every((s) => s === 'none') ? 'Not on the line yet' : 'Every stage passed';
  const stage = STAGES[at] as Stage;
  const name = stage[0]?.toUpperCase() + stage.slice(1);
  return {
    now: `Now at ${name}`,
    stopped: `Stopped at ${name}`,
    waiting: `Waiting at ${name}`,
    closed: `Closed at ${name}`,
  }[list[at] as 'now' | 'stopped' | 'waiting' | 'closed'];
}

const last = <T>(list: readonly T[], test: (value: T) => boolean) => [...list].reverse().find(test);

const ofType = <K extends PublicEvent['type']>(item: ItemState, type: K) =>
  item.events.filter((event): event is PublicEvent<K> => event.type === type);

const MECHANISMS: Record<PayloadOf<'action.refused'>['mechanism'], string> = {
  'token-permission': 'Token permissions',
  ruleset: 'The ruleset on main',
  'egress-policy': 'The egress policy',
  'admission-control': 'Admission control',
};

/** Pages verification found unchanged, for the strip under a picture of something with nothing to see. */
const unchangedPages = (item: ItemState) =>
  last(ofType(item, 'verification.finished'), () => true)?.payload.pages.filter((page) => page.changed === 0).length ??
  0;

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

  const judgement = last(ofType(item, 'judgement.made'), () => true);
  if (item.category === 'not-a-defect' && judgement) {
    return { type: 'judgement', page: capture(item, 'page')?.shot, judgement: judgement.payload };
  }

  const spec = last(ofType(item, 'spec.written'), () => true);
  if (item.outcome === 'needs-you' && spec) return { type: 'spec', spec: spec.payload, question: item.hold?.question };

  if (item.dependency) {
    const findings = last(ofType(item, 'gate.finished'), (event) => Boolean(event.payload.findings))?.payload.findings;
    if (item.dependency.security && findings) {
      return { type: 'scan', dependency: item.dependency, findings, unchanged: unchangedPages(item) };
    }
    return { type: 'package', dependency: item.dependency, unchanged: unchangedPages(item) };
  }

  const wipe = wipeOf(item);
  if (wipe) return wipe;

  const { signal, verified } = item.evidence;
  if (verified?.kind === 'metric') return { type: 'metric', evidence: verified, unchanged: unchangedPages(item) };
  if (verified?.kind === 'logs') {
    return { type: 'logs', before: signal?.kind === 'logs' ? signal : undefined, after: verified };
  }
  if (signal?.kind === 'metric') return { type: 'metric', evidence: signal, unchanged: 0 };

  const broken = capture(item, 'broken');
  if (broken) return { type: 'screenshot', shot: broken.shot, tag: 'NOW' };
  if (spec) return { type: 'spec', spec: spec.payload, question: item.hold?.question };
  return { type: 'none' };
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
