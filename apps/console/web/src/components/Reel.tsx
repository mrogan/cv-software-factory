/**
 * The reel: every work item as a card, oldest on the left and now on the right, and the timeline beneath.
 *
 * Per-frame work stays out of React (ADR 0007). Dragging, flicking and scrubbing the timeline move a position held
 * in a ref and write each card's transform directly; React hears only where the reel settles. A test counts renders
 * during a drag and fails if they grow with the number of frames.
 */
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { dayLabel, when } from '../format.ts';
import type { View } from '../projection/index.ts';
import { renders } from '../renders.ts';
import { Card, OUTCOME } from './Card.tsx';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';

const PLAY_EVERY_MS = 2500;
/** On first view the reel plays this many of the latest work items once. */
const AUTOPLAY = 8;

interface ReelProps {
  view: View;
  /** The card at the centre, when the reel is at rest. */
  centre: number;
  onCentre: (index: number) => void;
  onOpen: (index: number) => void;
  motion: boolean;
  /** Set when the viewer asked for a particular item, so the reel does not play itself. */
  asked: boolean;
}

const phone = () => innerWidth <= 720;

/** Where a position falls along the timeline, from 0 to 1, between the cards either side of it. */
function railAt(positions: readonly number[], p: number): number {
  const n = positions.length;
  const i = Math.max(0, Math.min(n - 1, Math.floor(p)));
  const [a, b] = [positions[i] ?? 0, positions[Math.min(n - 1, i + 1)] ?? 0];
  return a + (b - a) * (Math.max(0, Math.min(n - 1, p)) - i);
}

interface Drag {
  x: number;
  p0: number;
  moved: boolean;
  card: number | undefined;
  /** The last pointer position and time, for the speed of a flick. */
  lx: number;
  lt: number;
  v: number;
}

export function Reel({ view, centre, onCentre, onOpen, motion, asked }: ReelProps) {
  renders.reel++;
  const { cards, timeline } = view;
  const n = cards.length;
  const reel = useRef<HTMLElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLSpanElement>(null);
  const elements = useRef<(HTMLElement | null)[]>([]);
  /** Where the reel is, in cards: a whole number at rest, anything between while moving. */
  const position = useRef(centre);
  const [playing, setPlaying] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  /** Set while a finger or pointer is moving the reel or the timeline: nothing else moves it then. */
  const drag = useRef<Drag | undefined>(undefined);
  const scrubbing = useRef(false);
  // A live console's clock ticks every ten seconds, and each tick brings a new timeline with the same positions.
  // Keyed on the positions themselves, the drawing changes only when a card is added.
  const positionsKey = timeline.positions.join(' ');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for the positions
  const positions = useMemo(() => timeline.positions, [positionsKey]);

  /** Writes every card's place for a position. No React: this runs on every frame of a drag. */
  const layout = useCallback(
    (p: number, animate = false) => {
      const box = reel.current;
      if (!box) return;
      box.classList.toggle('anim', animate && motion);
      const width = Math.min(620, box.clientWidth - (phone() ? 40 : 200));
      const step = width * 0.9 + (phone() ? 12 : 28);
      box.style.setProperty('--card-w', `${width}px`);
      elements.current.forEach((el, i) => {
        if (!el) return;
        const d = i - p;
        const ad = Math.abs(d);
        el.style.transform = `translateX(${d * step - width / 2}px) scale(${1 - Math.min(ad, 1) * 0.1})`;
        el.style.opacity = String(ad > 2.6 ? 0 : Math.max(0, 1 - Math.min(ad, 1) * 0.3 - Math.max(0, ad - 1) * 0.4));
        el.style.zIndex = String(50 - Math.round(ad * 10));
        el.style.visibility = ad > 2.8 ? 'hidden' : 'visible';
        const atCentre = ad < 0.5;
        el.dataset.place = atCentre ? 'centre' : 'side';
        el.setAttribute('aria-hidden', String(!atCentre));
        for (const handle of el.querySelectorAll<HTMLElement>('.handle')) handle.tabIndex = atCentre ? 0 : -1;
      });
      if (playhead.current) playhead.current.style.left = `${railAt(positions, p) * 100}%`;
      position.current = p;
    },
    [motion, positions],
  );

  /** The position nearest a point along the timeline. */
  const positionFromRail = (f: number) => {
    for (let i = 0; i < n - 1; i++) {
      const [a, b] = [positions[i] ?? 0, positions[i + 1] ?? 1];
      if (f <= b) return i + Math.max(0, (f - a) / (b - a || 1));
    }
    return n - 1;
  };

  // React decides where the reel rests; this draws it there, sliding unless motion is off. Mid-gesture it waits:
  // letting go settles the reel from wherever the gesture left it.
  useLayoutEffect(() => {
    if (!drag.current && !scrubbing.current) layout(centre, true);
  }, [centre, layout]);

  const { title, outcome } = cards[centre] ?? {};
  useEffect(() => {
    if (title && outcome) setAnnouncement(`${centre + 1} of ${n}: ${title}. ${OUTCOME[outcome][0]}.`);
  }, [centre, n, title, outcome]);

  // The tallest card sets the reel's height, once fonts have loaded and whenever the width changes.
  useEffect(() => {
    const fit = () => {
      const tallest = Math.max(0, ...elements.current.map((el) => el?.offsetHeight ?? 0));
      if (reel.current) reel.current.style.height = `${tallest + 12}px`;
      layout(position.current);
    };
    fit();
    void document.fonts?.ready.then(fit);
    let timer = 0;
    const resize = () => {
      clearTimeout(timer);
      timer = window.setTimeout(fit, 80);
    };
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, [layout]);

  const settle = useCallback(
    (p: number) => {
      const index = Math.max(0, Math.min(n - 1, Math.round(p)));
      if (index === centre) layout(index, true);
      else onCentre(index);
    },
    [centre, layout, n, onCentre],
  );

  // On first view the reel plays the latest work items once, when it comes into sight. Never with motion off, and
  // not once the viewer has moved it themselves.
  const autoplay = useRef<'not yet' | 'waiting' | 'starting' | 'done'>('not yet');
  const stop = useCallback(() => {
    autoplay.current = 'done';
    setPlaying(false);
  }, []);

  // Play the history: a card every two and a half seconds, ending at now.
  useEffect(() => {
    if (!playing) return;
    if (!motion || centre >= n - 1) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => onCentre(centre + 1), PLAY_EVERY_MS);
    return () => clearTimeout(timer);
  }, [playing, motion, centre, n, onCentre]);

  // The reel waits where the history starts, and the watch for it coming into sight outlives new work arriving
  // (and development's second mount): only playing, or the viewer taking over, ends it.
  useEffect(() => {
    if (autoplay.current === 'done' || autoplay.current === 'starting') return;
    if (asked || !motion || n < 2 || !('IntersectionObserver' in window)) return;
    if (autoplay.current === 'not yet') {
      autoplay.current = 'waiting';
      onCentre(Math.max(0, n - AUTOPLAY));
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || autoplay.current !== 'waiting') return;
        observer.disconnect();
        autoplay.current = 'starting';
        setTimeout(() => {
          if (autoplay.current !== 'starting') return;
          autoplay.current = 'done';
          setPlaying(true);
        }, 600);
      },
      { threshold: 0.6 },
    );
    if (reel.current) observer.observe(reel.current);
    return () => observer.disconnect();
  }, [asked, motion, n, onCentre]);

  // Dragging the cards: a click on the centre card opens it, on a neighbour brings it to the centre.
  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('.handle')) return;
    const card = (event.target as Element).closest<HTMLElement>('.card')?.dataset.index;
    drag.current = {
      x: event.clientX,
      p0: position.current,
      moved: false,
      card: card === undefined ? undefined : Number(card),
      lx: event.clientX,
      lt: performance.now(),
      v: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || !reel.current) return;
    const dx = event.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 6) return;
    if (!d.moved) {
      d.moved = true;
      reel.current.classList.add('dragging');
      stop();
    }
    const now = performance.now();
    d.v = (event.clientX - d.lx) / Math.max(1, now - d.lt);
    d.lx = event.clientX;
    d.lt = now;
    const width = Math.min(620, reel.current.clientWidth - (phone() ? 40 : 200));
    const step = width * 0.9 + (phone() ? 12 : 28);
    layout(Math.max(-0.35, Math.min(n - 0.65, d.p0 - dx / step)));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = undefined;
    reel.current?.classList.remove('dragging');
    if (!d) return;
    if (!d.moved) {
      if (d.card === undefined) return;
      stop();
      if (d.card === centre) onOpen(d.card);
      else onCentre(d.card);
      return;
    }
    // A flick carries the reel half a card further.
    settle(position.current + (Math.abs(d.v) > 0.5 ? -Math.sign(d.v) * 0.5 : 0));
  };

  // Scrubbing the timeline.
  const fromRail = (event: React.PointerEvent) => {
    const box = rail.current?.getBoundingClientRect();
    if (box) layout(positionFromRail(Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, PageUp: -3, PageDown: 3 }[event.key];
    const to = step !== undefined ? centre + step : event.key === 'Home' ? 0 : event.key === 'End' ? n - 1 : undefined;
    if (to !== undefined) {
      event.preventDefault();
      stop();
      onCentre(Math.max(0, Math.min(n - 1, to)));
    } else if (event.key === 'Enter' && event.currentTarget === reel.current) {
      stop();
      onOpen(centre);
    }
  };

  const current = cards[centre];
  return (
    <section className="history" aria-labelledby="history-title">
      <div className="history-head">
        <div>
          <h2 id="history-title">The shop, change by change</h2>
          <p>
            Every work item, oldest on the left. Drag the cards or the timeline to watch the shop change; open one to
            see how it was done.
          </p>
        </div>
        <div className="transport">
          <button
            type="button"
            className="btn"
            aria-label={playing ? 'Pause' : 'Play the history'}
            onClick={() => {
              if (playing) stop();
              else {
                autoplay.current = 'done';
                if (centre >= n - 1) onCentre(0);
                setPlaying(true);
              }
            }}
            disabled={!motion}
            title={motion ? undefined : 'Motion is off'}
          >
            <Glyph name={playing ? 'pause' : 'play'} />
            <span className="play-label">{playing ? 'Pause' : 'Play the history'}</span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous work item"
            disabled={centre === 0}
            onClick={() => {
              stop();
              onCentre(centre - 1);
            }}
          >
            <Glyph name="left" />
          </button>
          <span className="count">
            {centre + 1} of {n}
          </span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next work item"
            disabled={centre >= n - 1}
            onClick={() => {
              stop();
              onCentre(centre + 1);
            }}
          >
            <Glyph name="right" />
          </button>
          <button
            type="button"
            className="now-btn"
            aria-pressed={centre === n - 1}
            onClick={() => {
              stop();
              onCentre(n - 1);
            }}
          >
            <span className="dot tone-signal blink" aria-hidden="true" />
            NOW
          </button>
        </div>
      </div>
      <section
        className="reel"
        ref={reel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the reel takes the arrow keys, as a carousel does
        tabIndex={0}
        aria-roledescription="carousel"
        aria-label="Work items, oldest first. Left and right arrows move; Enter opens one."
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = undefined;
          settle(position.current);
        }}
        onKeyDown={onKeyDown}
      >
        {cards.map((card, i) => (
          <Card
            key={card.number}
            card={card}
            index={i}
            count={n}
            ref={(el) => {
              elements.current[i] = el;
            }}
          />
        ))}
      </section>
      <div
        className="rail"
        ref={rail}
        role="slider"
        tabIndex={0}
        aria-label="Timeline of work items"
        aria-valuemin={1}
        aria-valuemax={n}
        aria-valuenow={centre + 1}
        aria-valuetext={current ? `${centre + 1} of ${n}: ${current.title}, ${when(current.startedAt)}` : undefined}
        onPointerDown={(event) => {
          scrubbing.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          stop();
          fromRail(event);
        }}
        onPointerMove={(event) => scrubbing.current && fromRail(event)}
        onPointerUp={() => {
          scrubbing.current = false;
          settle(position.current);
        }}
        onPointerCancel={() => {
          scrubbing.current = false;
          settle(position.current);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="track" />
        {timeline.days.map(({ index, day }) => (
          <span
            key={day}
            className="day"
            style={{ left: `calc(${(positions[index] ?? 0) * 100}% - 20px)` } as CSSProperties}
          >
            {dayLabel(day)}
          </span>
        ))}
        {cards.map((card, i) => (
          <span
            key={card.number}
            className={`tick tone-${OUTCOME[card.outcome][1]} ${i === centre ? 'here' : ''}`}
            style={{ left: `${(positions[i] ?? 0) * 100}%` }}
            title={`${CATEGORY_NAME[card.category]}: ${card.title}`}
          >
            <Glyph name={card.category} />
          </span>
        ))}
        {timeline.versions.map(({ index, version, rolledBack }) => (
          <span
            key={`${version}-${index}`}
            className={`ver ${rolledBack ? 'burnt' : ''} ${index === centre ? 'here' : ''}`}
            style={{ left: `${(positions[index] ?? 0) * 100}%` }}
          >
            {version}
          </span>
        ))}
        <span className="playhead" ref={playhead} />
      </div>
      {current && (
        <div className="at-line">
          <span>
            <b>{when(current.startedAt)}</b> · #{current.number} {current.title}
          </span>
          <span>
            The shop at <b className="mono">{current.shopVersion ?? 'its first version'}</b>
            {current.outcome === 'in-progress' && current.versions.onCanary && (
              <span className="attn-text"> · broken now; the fix is on the canary</span>
            )}
          </span>
        </div>
      )}
      <p className="sr" aria-live="polite">
        {announcement}
      </p>
      <p className="help what">
        <b>What am I looking at?</b> Each card is one work item: what was wrong or wanted, what changed on the site, and
        what it cost. Where nothing visible changed, the card shows what did: a graph, a package, a log line or the
        refusal that stopped an attack. Open a card for every stage, screenshot and model call.
      </p>
    </section>
  );
}
