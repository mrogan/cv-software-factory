/**
 * The line: one station per stage, each captioned with its state word and one figure, the returns drawn over them
 * one at a time, and a panel per stage listing what is in it.
 */
import type { Sense, Stage } from '@software-factory/events';
import { STAGES } from '@software-factory/events';
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STAGE_NAME, STATE } from '../../../../../docs/design/system/station.ts';
import { clock, duration } from '../format.ts';
import {
  type CapSpell,
  type Return,
  type SenseCount,
  type Station,
  type Status,
  type View,
  whileSending,
} from '../projection/index.ts';
import { Glyph } from './Glyph.tsx';

const BLURB: Record<Stage, string> = {
  sense: 'What the probes, the crawler, telemetry and visitor reports picked up.',
  triage: 'Signals deduplicated and backed with evidence before anyone plans work.',
  plan: 'Specs and questions. Improvements wait here for approval.',
  build: 'Coder agents write a failing test first, then the fix.',
  gates: 'Deterministic checks every pull request must pass. Always enforced.',
  review: 'The reviewer’s rounds, the describer, and the wait for Martin’s merge.',
  release: 'Signed images behind a canary that can roll itself back.',
  verify: 'Has the original signal cleared in production? New problems it finds go back to Sense.',
};

/** Where Triage takes work from: the five senses, each with what it watches. */
const SENSES: Record<Sense, [name: string, watches: string]> = {
  probe: ['Probes', 'a shopper’s journeys'],
  crawler: ['Crawler', 'every page and file'],
  metrics: ['Metrics', 'the app’s objectives'],
  logs: ['Logs', 'new error patterns'],
  report: ['Reports', 'from the widget'],
};

/** Sources not built for the demo, shown as such. */
const ELSEWHERE = ['Slack', 'Linear or Jira'];

const SHOW_MS = 5200;
const GAP_MS = 900;

/** Cycles through the returns, newest first, about five seconds each. With motion off, the newest holds still. */
function useReturn(returns: readonly Return[], motion: boolean, stopped: boolean): Return | undefined {
  const [index, setIndex] = useState(0);
  const [showing, setShowing] = useState(true);
  const key = returns.map((r) => `${r.item}@${r.at}`).join();
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new set of returns starts again from the newest
  useEffect(() => setIndex(0), [key]);
  useEffect(() => {
    if (!motion || returns.length === 0 || stopped) {
      setShowing(true);
      return;
    }
    setShowing(true);
    let timer = setTimeout(function hide() {
      setShowing(false);
      timer = setTimeout(() => {
        setIndex((i) => (i + 1) % returns.length);
        setShowing(true);
        timer = setTimeout(hide, SHOW_MS);
      }, GAP_MS);
    }, SHOW_MS);
    return () => clearTimeout(timer);
  }, [motion, returns.length, stopped]);
  if (stopped || !showing) return undefined;
  return returns[motion ? index % returns.length : 0];
}

/** The arc from the sender back to the receiver, in the line's 1344 × 220 coordinates. */
function arc(r: Return) {
  const x = (stage: Stage) => 84 + 168 * STAGES.indexOf(stage);
  const back = STAGES.indexOf(r.to) < STAGES.indexOf(r.from) ? 1 : -1;
  const [x1, x2] = [x(r.from) - 12 * back, x(r.to) + 12 * back];
  const span = Math.abs(x1 - x2);
  const peak = -34 - Math.min(16, span * 0.015);
  return { d: `M${x1} 20 Q${(x1 + x2) / 2} ${2 * peak - 20} ${x2} 20`, mid: (x1 + x2) / 2, peak };
}

/**
 * Parcels on the belt: running through a working stage, piling up in front of one that needs you, and queued in
 * front of one that has tickets waiting for it. Decorative: the counts are in the captions and the panels.
 */
function Parcels({ stations }: { stations: readonly Station[] }) {
  return (
    <g>
      {stations.flatMap((s, i) => {
        const x = 168 * i;
        if (s.queued && s.status === 'idle') {
          // Up to three, stacked two and one, on the belt just before the station.
          return [0, 1, 2]
            .slice(0, Math.min(3, s.queued))
            .map((n) => (
              <rect
                key={`${s.stage}-queued-${n}`}
                className="parcel"
                x={x - 36 + (n === 2 ? 8 : n * 16)}
                y={n === 2 ? 162 : 174}
                width="14"
                height="12"
                rx="1.5"
              />
            ));
        }
        if (s.status === 'working' || s.status === 'passing') {
          const style = {
            '--run-from': `${x}px`,
            '--run-to': `${x + 150}px`,
            '--run-time': s.status === 'passing' ? '6s' : '3.5s',
          } as CSSProperties;
          return [
            <g key={s.stage} className="run" style={style}>
              <rect className="parcel" x="0" y="174" width="14" height="12" rx="1.5" />
            </g>,
          ];
        }
        if (s.status === 'blocked' || s.status === 'failed') {
          return [0, 1].map((n) => (
            <rect
              key={`${s.stage}${n}`}
              className="parcel"
              x={x - 32 + n * 16}
              y="174"
              width="14"
              height="12"
              rx="1.5"
            />
          ));
        }
        return [];
      })}
    </g>
  );
}

interface LineProps {
  view: View;
  motion: boolean;
  onOpen: (item: string) => void;
  /** No events yet: the stations wait, idle, saying so. */
  pending?: boolean;
}

export function Line({ view, motion, onOpen, pending = false }: LineProps) {
  const [open, setOpen] = useState<Stage | null>(null);
  const line = useRef<HTMLElement>(null);
  const buttons = useRef(new Map<Stage, HTMLButtonElement>());
  const stopped = view.header.stopped !== undefined;
  const current = useReturn(view.returns, motion, stopped);

  const close = useCallback(() => {
    setOpen((was) => {
      if (was) buttons.current.get(was)?.focus();
      return null;
    });
  }, []);

  return (
    <section className="line" aria-label="The line" ref={line}>
      <ul className="stations">
        {view.stations.map((s) => {
          const sending = current?.from === s.stage;
          const status: Status = stopped ? 'blocked' : whileSending(s.status, sending);
          // At a spend cap, Triage uses the blocked drawing with its own word, and says when the cap resets.
          const capped = !stopped && s.cappedUntil !== undefined;
          const word = pending ? 'reading' : stopped ? 'stopped' : capped ? 'capped' : STATE[status].label;
          const tone = pending ? 'faint' : stopped ? 'attn' : STATE[status].tone;
          const figure = capped ? `until ${clock(s.cappedUntil ?? 0)}` : s.figure;
          return (
            <li key={s.stage}>
              <button
                type="button"
                className="stage"
                ref={(button) => {
                  if (button) buttons.current.set(s.stage, button);
                }}
                aria-expanded={open === s.stage}
                aria-controls="stage-panel"
                aria-label={
                  pending
                    ? `${STAGE_NAME[s.stage]}: reading the factory’s events`
                    : `${STAGE_NAME[s.stage]}: ${word}, ${figure}. Show what is in this stage`
                }
                disabled={pending}
                onClick={() => setOpen((was) => (was === s.stage ? null : s.stage))}
              >
                <sf-station kind={s.stage} status={status} decorative motion={motion ? undefined : 'off'} />
                <span className="cap" aria-hidden="true">
                  <span className="name">{STAGE_NAME[s.stage]}</span>
                  <span className="state">
                    <span className={`dot tone-${tone} ${tone === 'attn' ? 'ring' : ''}`} />
                    {word}
                    {!pending && <span className={`fig ${capped ? 'keep' : ''}`}>&nbsp;· {figure}</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <div className="overlay" aria-hidden="true">
        <svg viewBox="0 0 1344 220" aria-hidden="true">
          <defs>
            <marker
              id="ret-head"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="9"
              markerHeight="9"
              markerUnits="userSpaceOnUse"
              orient="auto"
            >
              <path className="ret-head" d="M2 1.5 L8 5 L2 8.5" />
            </marker>
          </defs>
          <Parcels stations={view.stations} />
          {current && <ReturnArc r={current} />}
        </svg>
        {current && <ReturnPill r={current} />}
      </div>
      <p className="ret-note" aria-hidden="true">
        {current && (
          <>
            <Glyph name="back" />
            {STAGE_NAME[current.from]} → {STAGE_NAME[current.to]} · {current.text}
          </>
        )}
      </p>
      {open && (
        <StagePanel
          stage={open}
          view={view}
          anchor={buttons.current.get(open)}
          container={line.current}
          onClose={close}
          onOpen={(item) => {
            setOpen(null);
            onOpen(item);
          }}
        />
      )}
    </section>
  );
}

function ReturnArc({ r }: { r: Return }) {
  return <path className="ret ret-arc show" d={arc(r).d} markerEnd="url(#ret-head)" />;
}

function ReturnPill({ r }: { r: Return }) {
  const { mid, peak } = arc(r);
  const style = { left: `${(mid / 1344) * 100}%`, top: `${(peak / 220) * 100}%` } as CSSProperties;
  return (
    <span className="ret ret-pill show" style={style}>
      <Glyph name="back" />
      {r.text}
    </span>
  );
}

/**
 * Where Triage's work comes from: each sense, the signals that became events and the tickets they opened. Counted
 * from events alone, so live and replay agree; the inbox's repeats are not events, and the panel says so.
 */
function Sources({ senses }: { senses: SenseCount[] }) {
  const reports = senses.find((row) => row.sense === 'report')?.routes;
  const routes = reports
    ? [
        reports.quarantined && `${reports.quarantined} quarantined`,
        reports.parked && `${reports.parked} parked`,
        reports.closed && `${reports.closed} closed`,
        reports.joined && `${reports.joined} joined a ticket`,
      ].filter(Boolean)
    : [];
  return (
    <div className="sources">
      <table>
        <caption className="label">Takes work from</caption>
        <thead>
          <tr>
            <th className="label">Sense</th>
            <th className="label num">Signals</th>
            <th className="label num">Tickets</th>
          </tr>
        </thead>
        <tbody>
          {senses.map((row) => (
            <tr key={row.sense}>
              <th scope="row">
                {SENSES[row.sense][0]}
                <small>{row.sense === 'report' && routes.length ? routes.join(' · ') : SENSES[row.sense][1]}</small>
              </th>
              <td className={`num ${row.signals ? '' : 'zero'}`}>{row.signals}</td>
              <td className={`num ${row.tickets ? '' : 'zero'}`}>{row.tickets}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="elsewhere">
        {ELSEWHERE.map((name) => (
          <span key={name} className="src off">
            {name}
            <em> not in the demo</em>
          </span>
        ))}
      </div>
      <p className="help">
        A signal counts here when it opened a ticket or added a sense’s evidence to one. A sense seeing an open ticket’s
        problem again is counted by the inbox, not here.
      </p>
    </div>
  );
}

const CAP_NAME = { day: 'The daily spend cap', month: 'The monthly spend cap' };

/** A spend cap in Triage's panel: while it holds, and for the rest of the day it cleared, written as returns are. */
function CapRow({ spell, t }: { spell: CapSpell; t: number }) {
  const cleared = spell.cleared;
  return (
    <div className="srow">
      <span className="id">cap</span>
      <span>
        {CAP_NAME[spell.cap]}: reached at {clock(spell.reached)}
        {cleared !== undefined && `, cleared at ${clock(cleared)}`}
        <small className={cleared === undefined ? 'tone-attn' : ''}>
          {cleared === undefined
            ? `Reports wait in the inbox until ${clock(spell.resets)}, ${duration(spell.resets - t)} from now`
            : `Reports waited in the inbox for ${duration(cleared - spell.reached)}`}
        </small>
      </span>
      <span className="aside">{cleared === undefined ? '' : '↺'}</span>
    </div>
  );
}

interface PanelProps {
  stage: Stage;
  view: View;
  anchor: HTMLElement | undefined;
  container: HTMLElement | null;
  onClose: () => void;
  onOpen: (item: string) => void;
}

function StagePanel({ stage, view, anchor, container, onClose, onOpen }: PanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const [place, setPlace] = useState<CSSProperties>({});
  const { rows, senses, caps, queued } = view.panels[stage];
  const returns = view.returns.filter((r) => r.from === stage);

  // Under its station, kept inside the line; on a phone the styles make it a bottom sheet instead.
  useLayoutEffect(() => {
    const position = () => {
      if (!anchor || !container) return;
      const box = container.getBoundingClientRect();
      const button = anchor.getBoundingClientRect();
      const centre = button.left - box.left + button.width / 2;
      const left = Math.max(0, Math.min(box.width - 400, centre - 200));
      setPlace({
        '--panel-left': `${left}px`,
        '--panel-top': `${button.bottom - box.top + 12}px`,
        '--caret-left': `${centre - left - 7}px`,
      } as CSSProperties);
    };
    position();
    addEventListener('resize', position);
    return () => removeEventListener('resize', position);
  }, [anchor, container]);

  useEffect(() => {
    title.current?.focus({ preventScroll: true });
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const onEscape = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', onEscape);
    };
  }, [anchor, onClose]);

  return (
    <div className="stage-panel" id="stage-panel" role="dialog" aria-labelledby="stage-title" ref={panel} style={place}>
      <span className="caret" />
      <header>
        <div>
          <h3 id="stage-title" tabIndex={-1} ref={title}>
            {STAGE_NAME[stage]}
          </h3>
        </div>
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <p>{BLURB[stage]}</p>
      {senses && <Sources senses={senses} />}
      {stage === 'plan' && queued > 0 && (
        <p className="queue-note">Tickets wait here for the planner, which takes one at a time.</p>
      )}
      {rows.length === 0 && returns.length === 0 && caps.length === 0 && (
        <div className="empty">Nothing in {STAGE_NAME[stage]} today.</div>
      )}
      {caps.map((spell) => (
        <CapRow key={`cap-${spell.cap}-${spell.reached}`} spell={spell} t={view.t} />
      ))}
      {returns.map((r) => (
        <div key={`return-${r.item}-${r.at}`} className="srow">
          <span className="id">#{r.item}</span>
          <span>
            Sent back to {STAGE_NAME[r.to]}
            <small>
              {r.detail} · {duration(view.t - r.at)} ago
            </small>
          </span>
          <span className="aside">↩</span>
        </div>
      ))}
      {rows.map((row) => (
        <button
          key={`${row.item}-${row.at}`}
          type="button"
          className="srow"
          onClick={() => onOpen(row.item)}
          aria-label={`Open #${row.item}, ${row.title}`}
        >
          <span className="id">#{row.item}</span>
          <span>
            {row.title}
            <small className={`tone-${row.tone}`}>{row.note}</small>
          </span>
          <span className="aside go">Open ›</span>
        </button>
      ))}
    </div>
  );
}
