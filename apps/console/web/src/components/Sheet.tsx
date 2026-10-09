/**
 * The sheet: one work item in full, raised from the bottom of the screen over most of it. It holds focus while it
 * is open and gives it back when it closes; previous and next step between work items, and the reel follows.
 */

import type { Sense } from '@software-factory/events';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AGENT_NAME,
  capital,
  clock,
  duration,
  inWords,
  isCommit,
  money,
  percent,
  plural,
  shortVersion,
  sinceStart,
  tokens,
  when,
} from '../format.ts';
import type {
  AgentRow,
  Attempt,
  Chapter,
  GateRow,
  Picture as PictureData,
  Sheet as SheetData,
  Sighting,
  ThreadReview,
} from '../projection/index.ts';
import { kindName, ONGOING, OutcomeWord, spendWords } from './Card.tsx';
import { CATEGORY_NAME, Glyph } from './Glyph.tsx';
import { LogoMark } from './Logos.tsx';
import { Picture, Shot } from './Pictures.tsx';

/** Pinned models by a readable name. A local model the console does not know shows as its id, still labelled local. */
const MODEL_NAME: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
  'qwen/qwen3.8-27b': 'Qwen3.8 27B',
};

/** The app's repository, where the factory's pull requests are. */
const APP_REPO = 'https://github.com/mrogan/cv-worlds-worst-website';

const SOURCE: Record<PictureData['type'], string> = {
  wipe: 'Playwright screenshots, taken when the signal fired and after rollout. The marks are drawn from the elements the probe checked.',
  screenshot: 'A Playwright screenshot, taken when the signal fired.',
  metric: 'Prometheus, kept in the event at verify, so the graph outlives the metrics’ retention.',
  logs: 'Loki and Tempo, excerpted into the events at the signal and at verify.',
  package: 'The pull request’s lockfile change, and every page compared with the version before.',
  scan: 'The image scan of both images, run as a required check in the pipeline.',
  rollback: 'Argo Rollouts’ analysis run, with the series it compared.',
  refusal: 'The mechanism’s own output, stored with the event when it refused.',
  judgement: 'The Jev request in the event: question set, model version and every answer with its probability.',
  quarantine:
    'The Jev request in the event, and the threshold in the factory’s policy that quarantines a report. The report’s text is not in it.',
  suggestion: 'The Jev request in the event, and the factory’s own screenshot of the page the report named.',
  spec: 'The planner’s spec, as it waits for Martin.',
  merge: 'The pull request’s last push, its checks and its review, as the events record them.',
  scope: 'The scope fence’s own output, stored with the event when it refused.',
  'tests-pass': 'The tests-first check’s own output, from running the change’s tests on the base.',
  spend: 'The gateway’s log of every call, summed for each agent.',
  blocking: 'The reviewer’s findings, kept in each review’s event.',
  pages: 'The crawler’s screenshots of the pages it crawled, each marked where its check looked.',
  http: 'The sense’s own request, and what came back, kept in the event.',
  console: 'The browser’s console, as Playwright recorded it, beside its screenshot of the page.',
  accessibility: 'axe, run in the browser by the sense, with the boxes of the elements it named.',
  none: '',
};

const SENSE_NAME: Record<Sense, string> = {
  probe: 'Probes',
  crawler: 'Crawler',
  metrics: 'Metrics',
  logs: 'Logs',
  report: 'Reports',
};

/** What each sense captures, for an evidence block's caption and its source line. */
const CAPTURED: Record<Sense, [caption: string, source: string]> = {
  probe: ['Probe', 'Playwright'],
  crawler: ['Crawler', 'the crawler’s request'],
  metrics: ['Metrics · alert', 'the series behind Prometheus’s alert'],
  logs: ['Log watcher', 'Loki'],
  report: ['Report', 'the widget'],
};

const KIND_OF: Partial<Record<PictureData['type'], string>> = {
  screenshot: 'screenshot',
  pages: 'every page',
  http: 'HTTP',
  console: 'console',
  accessibility: 'axe',
  logs: 'new pattern',
  metric: '',
};

/** The provider that served a row's calls, as the events name it. */
const PROVIDER: Record<AgentRow['provider'], string> = {
  typesafe: 'TypeSafe',
  anthropic: 'Anthropic',
  bedrock: 'Amazon Bedrock',
  local: 'local',
};

/** "Jev 1.13.0 · TypeSafe", "Claude Opus 5.5 · Anthropic". */
const modelName = (row: AgentRow) =>
  `${row.provider === 'typesafe' ? `Jev ${row.model.replace(/^jev-/, '')}` : (MODEL_NAME[row.model] ?? row.model)} · ${PROVIDER[row.provider]}`;

/** A list in words: "a, b and c". */
const listed = (words: string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '');

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

  const ongoing = ONGOING.has(card.outcome);
  const released = Boolean(card.versions.to || card.versions.from);
  const [from, to] = [card.versions.from, card.versions.to].map((v) => v && shortVersion(v));
  const versions = card.versions.rolledBack
    ? `${to} · rolled back to ${from}`
    : card.versions.onCanary
      ? `broken in ${from} · the fix is ${to}`
      : to
        ? `${from ?? '—'} → ${to}`
        : 'No release';
  const bySense = sheet.senseEvidence.length > 1;
  const total = sheet.agents.reduce((sum, a) => sum + a.cost, 0);
  const evidence = sheet.evidence;

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
                <span className="kind">{kindName(card)}</span>
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
              <div>
                <p className="lead">{sheet.story}</p>
                {sheet.storyBy === 'describer' && (
                  <p className="source byline">
                    The describer, from the ticket, the spec, the final diff and the review. The pull request’s own
                    description is on GitHub.
                  </p>
                )}
              </div>
              {card.sample && (
                <p className="notice sample-note">
                  <span className="label">Sample</span>
                  Written by hand to show what the console will show. Nothing here happened; the screenshots are of the
                  real shop, with this sample’s change made in a copy that went nowhere.
                </p>
              )}
              {sheet.report &&
                (sheet.report.quarantined ? (
                  <p className="report withheld">
                    A visitor’s report from {sheet.report.page}. It gave orders to the system, so it is quarantined. Its
                    text is kept, and shown only to Martin and to the visitor who sent it.
                  </p>
                ) : (
                  <p className="report withheld">
                    A visitor’s report from {sheet.report.page}. Its text is shown only to the visitor who sent it and
                    to Martin; what triage made of it is below.
                  </p>
                ))}
              <Section
                title="How it went"
                help="Step through the stages. The console shows only what had happened by then: replay and the live view are the same code."
              >
                <Replay chapters={sheet.chapters} motion={motion} key={card.number} />
              </Section>
              {bySense && (
                <Section
                  title="Evidence"
                  help="Captured when it happened, because the sources expire. One block for each sense, the first time it saw the problem."
                >
                  <div className="captures by-sense">
                    {sheet.senseEvidence.map((block) => (
                      <figure key={block.sense}>
                        <Picture picture={block.picture} interactive={false} />
                        <figcaption>
                          <span>
                            {CAPTURED[block.sense][0]}
                            {KIND_OF[block.picture.type] ? ` · ${KIND_OF[block.picture.type]}` : ''}
                          </span>
                          <span className="mono">{clock(block.at)}</span>
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                  <Source>
                    Each sense’s own capture: {listed(sheet.senseEvidence.map((block) => CAPTURED[block.sense][1]))}.
                  </Source>
                </Section>
              )}
              {!bySense && evidence.type !== 'spec' && evidence.type !== 'none' && (
                <Section title="Evidence" help="Captured when it happened, because the sources expire.">
                  <div className="evidence-big">
                    <Picture picture={evidence} interactive />
                  </div>
                  <Source>{SOURCE[evidence.type]}</Source>
                  {sheet.captures.length > 1 && (
                    <div className="captures">
                      {sheet.captures.map((capture) => (
                        <figure key={`${capture.shot.hash}-${capture.shot.route}-${capture.at}`}>
                          <div className="vis">
                            <Shot shot={capture.shot} numbered={evidence.type === 'pages'} />
                          </div>
                          <figcaption>
                            {/* Every page's screenshot is named by its page; the others by when in the story. */}
                            <span>{evidence.type === 'pages' ? capture.shot.route : SIDE_NAME[capture.side]}</span>
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
              {sheet.spec ? (
                <SpecSection sheet={sheet} />
              ) : (
                sheet.files && (
                  <Section title="The change" help="What the pull request touched.">
                    <div className="files">
                      {sheet.files.map((file) => (
                        <div key={file.path}>
                          <span>{file.path}</span>
                          <span className="plus">+{file.added}</span>
                          <span className="minus">−{file.removed}</span>
                        </div>
                      ))}
                    </div>
                  </Section>
                )
              )}
              {sheet.rounds.length > 0 && (
                <Section
                  title="Rounds"
                  help={`Each attempt the coder pushed, what the gates and the reviewer made of it, and why it went back. ${capital(inWords(sheet.facts.reviews?.of ?? 2, 'review'))} at most: after the last, anything still blocking waits for Martin.`}
                >
                  <Rounds rounds={sheet.rounds} after={sheet.after} />
                </Section>
              )}
              {sheet.review.length > 0 && (
                <Section
                  title="Review"
                  help="The reviewer reads the diff against the rules at the base commit, so a pull request cannot loosen the rules it is judged by. Its review is a signal, never a gate."
                >
                  <ReviewThread reviews={sheet.review} start={card.startedAt} open={card.picture.type === 'blocking'} />
                  <Source>
                    {card.pullRequest ? `The review the App posted on PR #${card.pullRequest}, kept in the event.` : ''}{' '}
                    Each rule as the app’s docs/REVIEWERS.md words it.
                  </Source>
                </Section>
              )}
            </div>
            <aside className="sheet-side">
              <dl className="facts-dl">
                <Fact name="Work item">#{card.number}</Fact>
                {sheet.facts.ticket && (
                  <>
                    <Fact name="Ticket">
                      {sheet.facts.ticket.category} · {sheet.facts.ticket.severity}
                    </Fact>
                    <Fact name="Fingerprint">{sheet.facts.ticket.fingerprint}</Fact>
                  </>
                )}
                {!sheet.seenBy && <Fact name="Found by">{sheet.facts.foundBy}</Fact>}
                {!released && card.seenOn ? (
                  <Fact name="Seen on">
                    <Version version={card.seenOn} sample={card.sample} />
                  </Fact>
                ) : (
                  <Fact name="Version">{versions}</Fact>
                )}
                {card.pullRequest && (
                  <Fact name="Pull request">
                    {/* A sample's pull request never existed, so it links nowhere. */}
                    {card.sample ? (
                      `#${card.pullRequest}`
                    ) : (
                      <a href={`${APP_REPO}/pull/${card.pullRequest}`}>#{card.pullRequest} on GitHub</a>
                    )}
                  </Fact>
                )}
                {sheet.facts.reviews && (
                  <Fact name="Reviews">
                    {sheet.facts.reviews.done} of {sheet.facts.reviews.of}
                  </Fact>
                )}
                <Fact name="Started">{when(card.startedAt)}</Fact>
                <Fact name={ongoing ? 'So far' : 'Start to finish'}>{duration(card.durationMs)}</Fact>
                <Fact name="Model spend">{card.calls ? spendWords(card) : 'none'}</Fact>
                <Fact name="Code written by humans">
                  {sheet.facts.humanLines} {sheet.facts.humanLines === 1 ? 'line' : 'lines'}
                </Fact>
              </dl>
              {sheet.seenBy && <SeenBy rows={sheet.seenBy} />}
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
                              {/* Where a local model ran is what matters, not whose model it is: a laptop, no logo. */}
                              {a.provider === 'local' ? (
                                <Glyph name="local" className="glyph logo" />
                              ) : (
                                <LogoMark name={a.provider === 'typesafe' ? 'jev' : 'anthropic'} />
                              )}
                              <span>
                                {AGENT_NAME[a.agent] ?? a.agent}
                                <small>{modelName(a)}</small>
                                {a.details.map((line) => (
                                  <small key={line} className="mono">
                                    {line}
                                  </small>
                                ))}
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
                          <td className={`num ${a.provider === 'local' ? 'free' : ''}`}>
                            {a.provider === 'local' ? '$0' : money(a.cost)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td>{card.local ? 'Total · all local' : `Total${ongoing ? ' so far' : ''}`}</td>
                        <td className="num">{sheet.agents.reduce((sum, a) => sum + a.calls, 0)}</td>
                        <td />
                        <td className="num">{card.local ? '$0' : money(total)}</td>
                      </tr>
                    </tfoot>
                  </table>
                ) : (
                  <p className="help">
                    <b>No model was called.</b> {sheet.noModel}
                  </p>
                )}
                <Source>
                  The gateway’s log of every call. On the replay site the same calls come from cassettes.
                  {sheet.agents.some((a) => a.provider === 'local') &&
                    ' Local calls are counted and capped like any other, and priced at nothing.'}
                </Source>
              </div>
              <div className="side-card">
                <h3>
                  Gates
                  {sheet.gatesAttempt && <span className="attempt"> · attempt {sheet.gatesAttempt}</span>}
                </h3>
                {sheet.gates.length ? (
                  <div className="gates">
                    {sheet.gates.map((g) => (
                      <Gate key={g.check} gate={g} />
                    ))}
                    {sheet.signals.length > 0 && (
                      <>
                        <span className="label sub">Signals, not required</span>
                        {sheet.signals.map((g) => (
                          <Gate key={g.check} gate={g} />
                        ))}
                      </>
                    )}
                  </div>
                ) : (
                  <p className="help">
                    {ongoing ? 'No pull request yet, so no gates have run.' : 'No pull request, so no gates ran.'}
                  </p>
                )}
                {sheet.earlier.map((line) => (
                  <p key={line} className="help gates-note">
                    {line}
                  </p>
                ))}
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

const GATE_GLYPH = { success: 'check', skipped: 'check', failure: 'cross', neutral: 'dash' } as const;

/** One check, its result and time, and its own one line where it gave one. */
function Gate({ gate }: { gate: GateRow }) {
  return (
    <div
      className={`gate ${gate.conclusion === 'failure' ? 'fail' : gate.conclusion === 'neutral' ? 'neutral' : 'pass'}`}
    >
      <Glyph name={GATE_GLYPH[gate.conclusion]} />
      <span>
        {gate.check}
        {gate.summary && <small>{gate.summary}</small>}
      </span>
      <span className="time">{gate.durationMs !== undefined ? duration(gate.durationMs) : ''}</span>
    </div>
  );
}

const RISK_WORDS: Record<string, string> = {
  'test-loosening': 'it loosens a test',
  'dependency-change': 'it changes a dependency',
  'security-headers': 'it touches security headers',
  'out-of-scope': 'it reaches outside the ticket',
};

/**
 * The spec: its outcome, its criteria, and its scope, with what the pull request changes in it, or what the last
 * patch the fence refused would have.
 */
function SpecSection({ sheet }: { sheet: SheetData }) {
  const { spec, scope, card } = sheet;
  if (!spec) return null;
  const of = scope?.of;
  const built = of !== undefined;
  const refused = of !== undefined && 'refused' in of;
  return (
    <Section
      title="The spec"
      help={
        built
          ? 'What the planner asked for, and the files it allowed the coder to change. A patch outside them is refused.'
          : card.outcome === 'needs-you'
            ? 'Acceptance criteria the planner proposes. Nothing is built until Martin approves.'
            : 'What the planner asked for, and the files it allows the coder to change. A patch outside them is refused.'
      }
    >
      <p className="spec-outcome">{spec.outcome}</p>
      <ul className={`criteria ${card.outcome === 'verified' ? 'met' : ''}`}>
        {spec.criteria.map((c) => (
          <li key={c.given + c.when}>
            <Glyph name={card.outcome === 'verified' ? 'check' : 'dash'} />
            <span>
              <em>GIVEN</em> {c.given} <em>WHEN</em> {c.when} <em>THEN</em> {c.expect}
            </span>
          </li>
        ))}
      </ul>
      {scope && (
        <table className="scope">
          <thead>
            <tr>
              <th>
                {of === undefined
                  ? 'May change'
                  : 'refused' in of
                    ? `May change · patch ${of.refused}, refused`
                    : `May change · PR #${of.pullRequest}`}
              </th>
              <th className="num">{built ? 'Added' : ''}</th>
              <th className="num">{built ? 'Removed' : ''}</th>
            </tr>
          </thead>
          <tbody>
            {scope.rows.map((row) => (
              <tr key={row.path} className={row.outside ? 'refused' : ''}>
                <td className={`path ${row.added === undefined ? 'muted' : ''}`}>
                  {row.path}
                  {/* The line-through and the colour say it to the eye; this says it to a screen reader. */}
                  {row.outside && (
                    <span className="sr">{refused ? ' (outside the scope, refused)' : ' (outside the scope)'}</span>
                  )}
                </td>
                {row.added === undefined ? (
                  <td className="muted" colSpan={2}>
                    {built ? 'untouched' : ''}
                  </td>
                ) : (
                  <>
                    <td className="num plus">+{row.added}</td>
                    <td className="num minus">−{row.removed}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="risks">
        <span className="label">Risks</span>
        <span>{spec.risks.length ? spec.risks.map((r) => RISK_WORDS[r] ?? r).join('; ') : 'none'}</span>
        <span className="label">Rollout</span>
        <span>{spec.rollout}</span>
      </p>
    </Section>
  );
}

const VERDICT = { approved: 'Approved', 'changes-requested': 'Changes asked', escalated: 'Escalated' } as const;

/**
 * Rounds: one row per attempt, one column per stage it passed through, and between two rows the same dashed return
 * arc the line draws, from the stage that sent it back to Build, so the shape learned on the line means the same here.
 */
function Rounds({ rounds, after }: { rounds: Attempt[]; after: SheetData['after'] }) {
  return (
    <div className="rounds">
      <span />
      <span className="colh">Build</span>
      <span className="colh">Gates</span>
      <span className="colh">Review</span>
      {rounds.map((a) => (
        <RoundRow key={a.attempt} attempt={a} />
      ))}
      {after && (
        <div className="after">
          <OutcomeWord outcome={after.outcome} />
          <span>{after.text}</span>
        </div>
      )}
    </div>
  );
}

/** Where each stage's column is centred in the return's row, out of 300. */
const COLUMN: Record<string, number> = { build: 50, gates: 150, review: 250 };

/** One attempt, in the coder's round of the same number: the line's round, as the return's pill names it. */
function RoundRow({ attempt: a }: { attempt: Attempt }) {
  const gates = a.gates;
  const review = a.review;
  const from = a.returned ? (COLUMN[a.returned.from] ?? 250) : 0;
  return (
    <>
      <div className="rn">
        Round<b>{a.attempt}</b>
      </div>
      <div className="cell">
        <span className="t">Attempt {a.attempt}</span>
        <small>
          {a.how}
          {a.commit ? ` · ${a.commit.slice(0, 7)}` : ''}
        </small>
        <small>
          <span className="plus">+{a.added}</span> <span className="minus">−{a.removed}</span> ·{' '}
          {plural(a.files, 'file')}
        </small>
      </div>
      <div className="cell">
        {gates ? (
          <>
            <span className={`t ${gates.state === 'passed' ? 'ok' : ''}`}>
              {gates.state !== 'running' && <Glyph name={gates.state === 'passed' ? 'check' : 'cross'} />}
              {gates.state === 'running' ? 'Running' : `${gates.passed} of ${gates.total}`}
            </span>
            {gates.state === 'failed' && <small>{gates.failed.join(', ')} failed</small>}
            {gates.testsFirst && (
              <small>
                {gates.testsFirst.failedOnBase
                  ? `tests fail on base${gates.testsFirst.figure ? `: ${gates.testsFirst.figure}` : ''}`
                  : 'tests pass on base'}
              </small>
            )}
          </>
        ) : (
          <span className="t muted">Waiting</span>
        )}
      </div>
      <div className="cell">
        {review ? (
          <>
            <span className={`t ${review.verdict === 'approved' ? 'ok' : ''}`}>
              {review.verdict === 'approved' && <Glyph name="check" />}
              {VERDICT[review.verdict]}
            </span>
            <small>
              {[
                review.blocking && `${review.blocking} blocking`,
                review.suggestions && plural(review.suggestions, 'suggestion'),
              ]
                .filter(Boolean)
                .join(' · ') || 'no findings'}
            </small>
          </>
        ) : (
          <span className="t muted">{gates?.state === 'failed' ? 'Not reviewed' : 'Waiting'}</span>
        )}
      </div>
      {a.returned && (
        <>
          <span />
          <div className="ret-row">
            <svg className="arc" viewBox="0 0 300 54" preserveAspectRatio="none" aria-hidden="true">
              <path className="ret-arc" d={`M${from} 0 C${from} 34 50 18 50 52`} />
            </svg>
            <svg className="head" viewBox="0 0 12 10" aria-hidden="true">
              <path d="M1.5 1.5 6 8.5 10.5 1.5" />
            </svg>
            <span className="ret-pill">
              <Glyph name="back" />
              {capital(a.returned.from)} → Build · {a.returned.detail}
            </span>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The review thread: each review as the reviewer posted it, and each finding with where it is, whether it blocks, what
 * it says and the rule it cites, in full. Blocking is solid ink and a suggestion dashed; a finding still blocking
 * when the work is held for Martin turns ember, because then a person must act on it.
 */
function ReviewThread({ reviews, start, open }: { reviews: ThreadReview[]; start: number; open: boolean }) {
  return reviews.map((r, i) => (
    <div className="round" key={r.number}>
      <div className="round-h">
        <span>
          <b>Review {r.number}</b> · {VERDICT[r.verdict].toLowerCase()}
        </span>
        <span className="mono muted">
          {sinceStart(r.at - start)}
          {r.attempt ? ` · attempt ${r.attempt}` : ''}
        </span>
      </div>
      <p className="note">{r.note}</p>
      {r.findings.length > 0 && (
        <ul className="remarks">
          {r.findings.map((f) => (
            <li className="remark" key={`${f.path}:${f.line}:${f.comment}`}>
              <div className="top">
                <span
                  className={`weight ${f.blocking ? 'blocking' : 'suggestion'} ${open && f.blocking && i === reviews.length - 1 ? 'open' : ''}`}
                >
                  {f.blocking ? 'Blocking' : 'Suggestion'}
                </span>
                <span className="where">
                  {f.path}:{f.line}
                </span>
              </div>
              <p>{f.comment}</p>
              {f.rule && (
                <div className="cites">
                  <span className="n">RULE {f.rule.number}</span>
                  {f.rule.title && <b>{f.rule.title}.</b>}
                  {f.rule.text && <span>{f.rule.text}</span>}
                </div>
              )}
              {f.criterion && (
                <div className="cites">
                  <span className="n">CRITERION {f.criterion.number}</span>
                  {f.criterion.text && <span>{f.criterion.text}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  ));
}

/** Who saw a ticket's problem: every sense, in the order they first saw it, and those that haven't yet. */
function SeenBy({ rows }: { rows: Sighting[] }) {
  return (
    <div className="side-card seen-by">
      <h3>Seen by</h3>
      <ul>
        {rows.map((row) => (
          <li key={row.sense} className={row.at === undefined ? 'unseen' : ''}>
            <span className="label">{SENSE_NAME[row.sense]}</span>
            <span>
              {row.check ? capital(row.check) : 'None yet'}
              {(row.opened || row.added) && <small>{row.opened ? 'opened the ticket' : row.added}</small>}
            </span>
            <span className="mono">{row.at !== undefined ? clock(row.at) : ''}</span>
          </li>
        ))}
      </ul>
      <p className="help">
        Each sense adds its evidence the first time it sees the problem. After that the inbox counts it, so nothing here
        repeats.
      </p>
    </div>
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

/**
 * The app's version: a commit by its short form, linked to the commit and with the whole of it on hover. A sample's
 * commit never existed, so it links nowhere.
 */
function Version({ version, sample }: { version: string; sample: boolean }) {
  if (!isCommit(version)) return version;
  const short = shortVersion(version);
  if (sample) return <span title={version}>{short}</span>;
  return (
    <a href={`${APP_REPO}/commit/${version}`} title={version}>
      {short}
    </a>
  );
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
              {tag} · {shortVersion(site.shot.version)}
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
              className={`ch tone-${c.tone} ${i === at ? 'here' : ''} ${i < at ? 'done' : ''} ${i % 2 ? 'odd' : ''} ${c.waiting ? 'waiting' : ''}`}
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
