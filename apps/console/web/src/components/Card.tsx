/**
 * A card in the reel: the item's category, kind and outcome; its picture; a title and two lines; one line of
 * facts; and eight segments, one per stage.
 */
import { STAGES } from '@software-factory/events';
import { memo, type Ref } from 'react';
import { duration, money, shortWhen } from '../format.ts';
import type { Card as CardData, Outcome, Versions } from '../projection/index.ts';
import { segmentsLabel } from '../projection/index.ts';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';
import { Picture } from './Pictures.tsx';

const KIND_NAME: Record<CardData['kind'], string> = {
  'defect-fix': 'Defect fix',
  'injected-defect': 'Injected defect',
  improvement: 'Improvement',
  'dependency-update': 'Dependency update',
  'red-team': 'Red-team attack',
  'visitor-report': 'Visitor report',
};

/** The kind of work, saying when a visitor started it: never which visitor. */
export function kindName({ kind, byVisitor }: Pick<CardData, 'kind' | 'byVisitor'>): string {
  if (byVisitor && kind === 'injected-defect') return 'Injected by a visitor';
  if (byVisitor && kind === 'red-team') return 'Red-team attack by a visitor';
  return KIND_NAME[kind];
}

/** An outcome's word and tone, and whether it waits on a human. */
export const OUTCOME: Record<Outcome, [word: string, tone: 'ok' | 'attn' | 'faint' | 'signal', waits: boolean]> = {
  verified: ['Verified', 'ok', false],
  'rolled-back': ['Rolled back', 'attn', false],
  held: ['Held for a human', 'attn', true],
  closed: ['Closed · no change', 'faint', false],
  'needs-you': ['Needs you', 'attn', true],
  'in-progress': ['In progress', 'signal', false],
};

export function OutcomeWord({ outcome }: { outcome: Outcome }) {
  const [word, tone, waits] = OUTCOME[outcome];
  const dot = outcome === 'in-progress' ? 'blink' : waits ? 'ring alarm' : tone === 'attn' ? 'ring' : '';
  return (
    <span className={`out tone-${tone}`}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      {word}
    </span>
  );
}

/** The version pill: what shipped, what it replaced when that was rolled back, what is still on the canary. */
export function VersionPill({ versions }: { versions: Versions }) {
  const { from, to, rolledBack, onCanary } = versions;
  if (!to && !from) return <span className="ver muted">no release</span>;
  if (rolledBack) {
    return (
      <span className="ver">
        <s>{to}</s> → {from}
      </span>
    );
  }
  if (onCanary) {
    return (
      <span className="ver">
        {from} → <span className="muted">{to}</span>
      </span>
    );
  }
  return <span className="ver">{to ?? from}</span>;
}

const SEGMENT_CLASS = {
  passed: 'o',
  skipped: 's',
  now: 'n',
  stopped: 'x',
  waiting: 'w',
  closed: 'k',
  none: '',
} as const;

interface CardProps {
  card: CardData;
  index: number;
  count: number;
  ref?: Ref<HTMLElement>;
}

export const Card = memo(function Card({ card, index, count, ref }: CardProps) {
  const [word] = OUTCOME[card.outcome];
  return (
    <article
      ref={ref}
      className="card"
      data-index={index}
      aria-roledescription="slide"
      aria-label={`${index + 1} of ${count}: ${card.title}. ${word}`}
    >
      <div className="card-top">
        <span className="cat">
          <Glyph name={card.category} />
          {CATEGORY_NAME[card.category]}
          <span className="kind">· {kindName(card)}</span>
        </span>
        <OutcomeWord outcome={card.outcome} />
      </div>
      <Picture picture={card.picture} interactive={false} />
      <div>
        <h3>{card.title}</h3>
        <p className="desc">{card.description}</p>
      </div>
      <div className="meta">
        {card.sample && <span className="pill-sample">Sample</span>}
        <b>#{card.number}</b>
        <VersionPill versions={card.versions} />
        {card.pullRequest && <span className="opt">PR #{card.pullRequest}</span>}
        <span>{shortWhen(card.startedAt)}</span>
        <span>
          {duration(card.durationMs)}
          {card.outcome === 'in-progress' || card.outcome === 'needs-you' || card.outcome === 'held' ? ' so far' : ''}
        </span>
        <span>{money(card.spend)}</span>
      </div>
      <div className="card-foot">
        <span className="prog" role="img" aria-label={segmentsLabel(card.segments)}>
          {card.segments.map((segment, i) => (
            <i key={STAGES[i]} className={SEGMENT_CLASS[segment]} />
          ))}
        </span>
        <span className="open-hint" aria-hidden="true">
          OPEN ↑
        </span>
      </div>
    </article>
  );
});
