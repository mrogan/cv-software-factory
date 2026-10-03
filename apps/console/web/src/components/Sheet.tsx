/**
 * The sheet: one work item in full, raised from the bottom of the screen over most of it. It holds focus while it
 * is open and gives it back when it closes; previous and next step between work items, and the reel follows.
 */
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { duration, money, percent, sinceStart, tokens, when } from '../format.ts';
import type { Chapter, Sheet as SheetData } from '../projection/index.ts';
import { KIND_NAME, OutcomeWord } from './Card.tsx';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';
import { LogoMark } from './Logos.tsx';
import { Picture, Shot } from './Pictures.tsx';

const AGENT_NAME: Record<string, string> = {
  triage: 'Triage',
  planner: 'Planner',
  coder: 'Coder',
  reviewer: 'Reviewer',
  'red-team': 'Red-team agent',
};

const MODEL_NAME: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

const SOURCE: Record<string, string> = {
  wipe: 'Playwright screenshots, taken when the signal fired and after rollout. The marks are drawn from the elements the probe checked.',
  screenshot: 'A Playwright screenshot, taken when the signal fired.',
  metric: 'Prometheus, kept in the event at verify, so the graph outlives the metrics’ retention.',
  logs: 'Loki and Tempo, excerpted into the events at the signal and at verify.',
  package: 'The pull request’s lockfile change, and every page compared with the version before.',
  scan: 'The image scan of both images, run as a required check in the pipeline.',
  rollback: 'Argo Rollouts’ analysis run, with the series it compared.',
  refusal: 'The mechanism’s own output, stored with the event when it refused.',
  judgement: 'The Jev request in the event: question set, model version and every answer with its probability.',
  spec: 'The planner’s spec, as it waits for Martin.',
  none: '',
};

const SIDE_NAME: Record<string, string> = {
  broken: 'Signal',
  canary: 'On the canary',
  fixed: 'Full rollout',
  after: 'Full rollout',
  before: 'Before',
};

interface SheetProps {
  sheet: SheetData;
  index: number;
  count: number;
  motion: boolean;
  onStep: (to: number) => void;
  onClose: () => void;
}

export function Sheet({ sheet, index, count, motion, onStep, onClose }: SheetProps) {
  const dialog = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const [risen, setRisen] = useState(false);
  const { card } = sheet;

  // Rise on the next frame, so the move from below is drawn; give focus back on the way out.
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    document.body.classList.add('locked');
    const frame = requestAnimationFrame(() => setRisen(true));
    return () => {
      cancelAnimationFrame(frame);
      document.body.classList.remove('locked');
      const back = opener.current;
      if (back instanceof HTMLElement && document.contains(back)) back.focus({ preventScroll: true });
    };
  }, []);

  // A new work item starts at the top, with its title focused.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs for each work item the sheet shows
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    title.current?.focus({ preventScroll: true });
  }, [card.number]);

  const close = () => {
    if (!motion) return onClose();
    setRisen(false);
    setTimeout(onClose, 420);
  };

  // Escape closes; Tab stays inside while the sheet is open.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex="0"]'),
    ];
    const [first, last] = [focusable[0], focusable.at(-1)];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const ongoing = card.outcome === 'in-progress' || card.outcome === 'needs-you' || card.outcome === 'held';
  const versions = card.versions.rolledBack
    ? `${card.versions.to} · rolled back to ${card.versions.from}`
    : card.versions.onCanary
      ? `broken in ${card.versions.from} · the fix is ${card.versions.to}`
      : card.versions.to
        ? `${card.versions.from ?? '—'} → ${card.versions.to}`
        : 'No release';
  const total = sheet.agents.reduce((sum, a) => sum + a.cost, 0);

  return (
    <>
      <div className={`scrim ${risen ? 'open' : ''}`} onClick={close} aria-hidden="true" />
      <section
        ref={dialog}
        className={`sheet ${risen ? 'open' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-title"
        onKeyDown={onKeyDown}
      >
        <div className="grab" aria-hidden="true" />
        <div className="wrap sheet-wrap">
          <header className="sheet-head">
            <div className="sheet-title">
              <div className="kicker">
                <span className="cat">
                  <Glyph name={card.category} />
                  {CATEGORY_NAME[card.category]}
                </span>
                <span className="kind">{KIND_NAME[card.kind]}</span>
                <OutcomeWord outcome={card.outcome} />
                {card.sample && <span className="pill-sample">Sample</span>}
              </div>
              <h2 id="sheet-title" tabIndex={-1} ref={title}>
                {card.title}
              </h2>
            </div>
            <div className="sheet-nav">
              <button
                type="button"
                className="icon-btn"
                aria-label="Previous work item"
                disabled={index === 0}
                onClick={() => onStep(index - 1)}
              >
                <Glyph name="left" />
              </button>
              <span className="count">#{card.number}</span>
              <button
                type="button"
                className="icon-btn"
                aria-label="Next work item"
                disabled={index >= count - 1}
                onClick={() => onStep(index + 1)}
              >
                <Glyph name="right" />
              </button>
              <button type="button" className="icon-btn close" aria-label="Close" onClick={close}>
                <Glyph name="cross" />
              </button>
            </div>
          </header>
        </div>
        <div className="sheet-scroll" ref={scroller}>
          <div className="wrap sheet-body">
            <div className="sheet-main">
              <p className="lead">{sheet.story}</p>
              {card.sample && (
                <p className="notice sample-note">
                  <span className="label">Sample</span>
                  Written by hand to show what the console will show. Nothing here happened; the screenshots are of the
                  real shop, with this sample’s change made in a copy that went nowhere.
                </p>
              )}
              {sheet.report && (
                <p className="report withheld">
                  A visitor’s report from {sheet.report.page}. Its text is shown only to the visitor who sent it and to
                  Martin; what triage made of it is below.
                </p>
              )}
              <Section
                title="How it went"
                help="Step through the stages. The console shows only what had happened by then: replay and the live view are the same code."
              >
                <Replay chapters={sheet.chapters} motion={motion} key={card.number} />
              </Section>
              {card.picture.type !== 'spec' && card.picture.type !== 'none' && (
                <Section title="Evidence" help="Captured when it happened, because the sources expire.">
                  <div className="evidence-big">
                    <Picture picture={card.picture} interactive />
                  </div>
                  <Source>{SOURCE[card.picture.type]}</Source>
                  {sheet.captures.length > 1 && (
                    <div className="captures">
                      {sheet.captures.map((capture) => (
                        <figure key={`${capture.shot.hash}-${capture.at}`}>
                          <div className="vis">
                            <Shot shot={capture.shot} />
                          </div>
                          <figcaption>
                            <span>{SIDE_NAME[capture.side]}</span>
                            <span className="mono">{sinceStart(capture.at - card.startedAt)}</span>
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                  {sheet.pages && (
                    <div className="regress">
                      <span className="label">After rollout, against {sheet.pages.against}</span>
                      <div className="row">
                        {sheet.pages.list.map((page) => (
                          <figure key={page.page}>
                            <div className="vis">{page.screenshot && <Shot shot={page.screenshot} />}</div>
                            <figcaption>
                              <span>{page.page}</span>
                              <span className={`mono change ${page.intended ? 'meant' : 'same'}`}>
                                {percent(page.changed)} · {page.intended ? 'intended' : 'same'}
                              </span>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                      <Source>
                        Playwright screenshots of each page at full rollout, compared pixel by pixel with the version
                        before.
                      </Source>
                    </div>
                  )}
                </Section>
              )}
              {(sheet.spec || sheet.files) && (
                <Section
                  title={card.outcome === 'needs-you' ? 'The spec' : 'The change'}
                  help={
                    card.outcome === 'needs-you'
                      ? 'Acceptance criteria the planner proposes. Nothing is built until Martin approves.'
                      : 'What the spec asked for, and what the pull request touched.'
                  }
                >
                  {sheet.spec && (
                    <ul className="criteria">
                      {sheet.spec.criteria.map((c) => (
                        <li key={c.given + c.when}>
                          <Glyph name={card.outcome === 'verified' ? 'check' : 'dash'} />
                          <span>
                            <em>GIVEN</em> {c.given} <em>WHEN</em> {c.when} <em>THEN</em> {c.expect}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {sheet.files && (
                    <div className="files">
                      {sheet.files.map((file) => (
                        <div key={file.path}>
                          <span>{file.path}</span>
                          <span className="plus">+{file.added}</span>
                          <span className="minus">−{file.removed}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </Section>
              )}
            </div>
            <aside className="sheet-side">
              <dl className="facts-dl">
                <Fact name="Work item">#{card.number}</Fact>
                <Fact name="Found by">{sheet.facts.foundBy}</Fact>
                <Fact name="Version">{versions}</Fact>
                <Fact name="Pull request">{card.pullRequest ? `#${card.pullRequest}` : '—'}</Fact>
                <Fact name="Started">{when(card.startedAt)}</Fact>
                <Fact name={ongoing ? 'So far' : 'Start to finish'}>{duration(card.durationMs)}</Fact>
                <Fact name="Model spend">{money(card.spend)}</Fact>
                <Fact name="Code written by humans">
                  {sheet.facts.humanLines} {sheet.facts.humanLines === 1 ? 'line' : 'lines'}
                </Fact>
              </dl>
              <div className="side-card">
                <h3>Agents and models</h3>
                {sheet.agents.length ? (
                  <table className="models">
                    <thead>
                      <tr>
                        <th>Agent and model</th>
                        <th className="num">Calls</th>
                        <th className="num">Tokens</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.agents.map((a) => (
                        <tr key={`${a.agent}/${a.model}`}>
                          <td>
                            <div className="who">
                              <LogoMark name={a.provider === 'typesafe' ? 'jev' : 'anthropic'} />
                              <span>
                                {AGENT_NAME[a.agent] ?? a.agent}
                                <small>
                                  {a.provider === 'typesafe' ? `Jev ${a.model}` : (MODEL_NAME[a.model] ?? a.model)}
                                  {a.settings && ` · ${a.settings}`}
                                </small>
                              </span>
                            </div>
                          </td>
                          <td className="num">{a.calls}</td>
                          <td className="num">
                            {a.tokensIn ? (
                              <>
                                {tokens(a.tokensIn)} in<small>{tokens(a.tokensOut)} out</small>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="num">{money(a.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>Total{ongoing ? ' so far' : ''}</td>
                        <td className="num">{sheet.agents.reduce((sum, a) => sum + a.calls, 0)}</td>
                        <td />
                        <td className="num">{money(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <p className="help">No model was called.</p>
                )}
                <Source>The gateway’s log of every call. On the replay site the same calls come from cassettes.</Source>
              </div>
              <div className="side-card">
                <h3>Gates</h3>
                {sheet.gates.length ? (
                  <div className="gates">
                    {sheet.gates.map((g) => (
                      <div key={g.check} className={`gate ${g.conclusion === 'failure' ? 'fail' : 'pass'}`}>
                        <Glyph name={g.conclusion === 'failure' ? 'cross' : 'check'} />
                        <span>{g.check}</span>
                        <span className="time">{duration(g.durationMs)}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="help">No pull request, so no gates ran.</p>
                )}
                {card.outcome === 'rolled-back' && (
                  <p className="help gates-note">Every gate passed. The canary caught what tests could not.</p>
                )}
              </div>
            </aside>
          </div>
        </div>
      </section>
    </>
  );
}

function Section({ title, help, children }: { title: string; help: string; children: ReactNode }) {
  return (
    <section className="sec">
      <h3>{title}</h3>
      <p className="help">{help}</p>
      {children}
    </section>
  );
}

function Source({ children }: { children: ReactNode }) {
  return <p className="source">{children}</p>;
}

function Fact({ name, children }: { name: string; children: ReactNode }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{children}</dd>
    </>
  );
}

const SIDE_TAG: Record<string, [string, 'attn' | 'ok' | 'faint' | 'signal']> = {
  before: ['BEFORE', 'faint'],
  broken: ['BROKEN', 'attn'],
  canary: ['CANARY', 'signal'],
  fixed: ['FIXED', 'ok'],
  after: ['AFTER', 'ok'],
};

/** The stage scrubber: a chapter per step, the events up to the chosen one, and the site as it stood then. */
function Replay({ chapters, motion }: { chapters: Chapter[]; motion: boolean }) {
  const last = chapters.length - 1;
  const [at, setAt] = useState(last);
  const [playing, setPlaying] = useState(false);
  const chapter = chapters[Math.min(at, last)];
  const start = chapters[0]?.at ?? 0;

  useEffect(() => {
    if (!playing) return;
    if (at >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setAt((a) => a + 1), 1200);
    return () => clearTimeout(timer);
  }, [playing, at, last]);

  if (!chapter) return null;
  const site = chapter.site;
  const [tag, tone] = site ? (SIDE_TAG[site.side] ?? ['', 'faint']) : ['', 'faint'];
  const events = chapters.slice(0, at + 1).filter((c) => c.actor);
  return (
    <div className={`replay ${site ? '' : 'solo'}`}>
      {site && (
        <div className="site">
          <div className="site-head">
            <span className="label">The site at {sinceStart(chapter.at - start)}</span>
            <span className={`label tone-${tone} toned`}>
              {tag} · {site.shot.version}
            </span>
          </div>
          <div className="vis">
            <Shot shot={site.shot} />
          </div>
        </div>
      )}
      <div>
        <div className="ctl">
          <span className="clock">{sinceStart(chapter.at - start)}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label="Previous step"
            disabled={at === 0}
            onClick={() => {
              setPlaying(false);
              setAt(Math.max(0, at - 1));
            }}
          >
            <Glyph name="left" />
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!motion && at === last}
            onClick={() => {
              if (playing) return setPlaying(false);
              if (!motion) return setAt(last);
              if (at >= last) setAt(0);
              setPlaying(true);
            }}
          >
            {playing ? 'Pause' : at >= last ? 'Replay' : 'Play'}
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label="Next step"
            disabled={at >= last}
            onClick={() => {
              setPlaying(false);
              setAt(Math.min(last, at + 1));
            }}
          >
            <Glyph name="right" />
          </button>
        </div>
        <div className="scrub">
          <div className="rl" />
          <div className="fill" style={{ width: `${chapter.position}%` }} />
          {chapters.map((c, i) => (
            <button
              key={`${c.label}-${c.at}`}
              type="button"
              className={`ch tone-${c.tone} ${i === at ? 'here' : ''} ${i < at ? 'done' : ''} ${i % 2 ? 'odd' : ''}`}
              style={{ left: `${c.position}%` }}
              aria-label={`${sinceStart(c.at - start)}, ${c.label.toLowerCase()}`}
              aria-current={i === at ? 'step' : undefined}
              onClick={() => {
                setPlaying(false);
                setAt(i);
              }}
            >
              <i />
              <span>{c.label}</span>
            </button>
          ))}
        </div>
        <ol className="events">
          {events.map((c, i) => (
            <li key={`${c.label}-${c.at}`} className={`event ${i === events.length - 1 ? 'now' : ''}`}>
              <span className="mono">{sinceStart(c.at - start)}</span>
              <span className="mono actor">{c.actor}</span>
              <span>{c.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
