/**
 * The Canary panel: the release in flight against the version it would replace, for everyone, full width under the
 * line. It is always there; idle, it is one line. Under the steps and the measures are Martin's controls: buttons for
 * him, and for a visitor the same controls as labels beside what each does.
 */
import type { ReleaseControl } from '@software-factory/events';
import { useState } from 'react';
import { type Admin, said, write } from '../admin.ts';
import { capital, clock, clockSeconds, duration, isCommit, shortVersion, shortWhen, times } from '../format.ts';
import type { CanaryView, Carried, Measured, Release } from '../projection/index.ts';
import {
  type Control,
  controlsOf,
  endedWords,
  failedLooks,
  MEASURES,
  ownWords,
  SIGNALLED,
  sawOf,
  stoppedBy,
} from '../projection/release.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph, type GlyphName } from './Glyph.tsx';
import { type Asked, Key, useStepUp } from './StepUp.tsx';

export type Tone = 'signal' | 'ok' | 'attn' | 'faint';
type Phase = Measured['stepped']['analysis']['phase'];

/** A measure's verdict, from the analysis's own phases: in flight is ink, only a pass is green, a failure is warm. */
export const VERDICT: Record<Phase | 'dry' | 'none', [word: string, tone: Tone, glyph: GlyphName]> = {
  successful: ['passed', 'ok', 'check'],
  failed: ['failed', 'attn', 'cross'],
  running: ['measuring', 'signal', 'ring'],
  pending: ['waiting', 'faint', 'dash'],
  error: ['could not measure', 'faint', 'dash'],
  inconclusive: ['inconclusive · waits for Martin', 'attn', 'ring'],
  dry: ['recorded', 'faint', 'dash'],
  none: ['not measured', 'faint', 'dash'],
};

/** A verdict, and for a measure a rollback failed, how many of its looks failed when the event counted them: "failed twice". */
export function Verdict({ phase, looks }: { phase: keyof typeof VERDICT; looks?: number | undefined }) {
  const [word, tone, glyph] = VERDICT[phase];
  return (
    <span className={`v tone-${tone}`}>
      <Glyph name={glyph} />
      {looks === undefined ? word : `${word} ${times(looks)}`}
    </span>
  );
}

/** How the release stands, as the kicker says it, in its tone. */
export function standing(r: Release): [word: string, tone: Tone, dot: string] {
  const { end, weight } = r;
  if (!end) {
    // Martin's pause holds it: still, not blinking, until he resumes, promotes or aborts it.
    if (r.paused && !r.dryRun) return [`Paused by Martin at ${weight}%`, 'signal', ''];
    const word = weight ? `Canary · ${weight}%` : 'Canary · starting';
    return r.dryRun ? [`${word}, as the dry run records it`, 'faint', ''] : [`${word} of traffic`, 'signal', 'blink'];
  }
  const [word, tone]: [string, Tone] =
    end.kind === 'promoted'
      ? ['Promoted · all traffic', 'ok']
      : [`${capital(endedWords(end))} at ${end.weight}%`, 'attn'];
  return r.dryRun ? [`${word}, as the dry run records it`, 'faint', ''] : [word, tone, tone === 'attn' ? 'ring' : ''];
}

/** What a release's end did at the step it reached, as the step says it: "rolled back here". */
const CUT = { 'rolled-back': 'rolled back', stop: 'stopped', martin: 'aborted', error: 'could not be judged' } as const;

/** A step's verdict: its analysis's phase, or failed when any of its measures failed. */
const stepPhase = (m: Measured): Phase =>
  m.stepped.analysis.measures.some((x) => x.phase === 'failed') ? 'failed' : m.stepped.analysis.phase;

/** The steps: a bar that is the canary's share of the traffic, with a stop at each step's weight. */
function Steps({ r, tone }: { r: Release; tone: Tone }) {
  const { end } = r;
  return (
    <div className={`steps-track ${r.dryRun ? 'dry' : ''}`}>
      <span className="rl" />
      <span className={`fill tone-${r.dryRun ? 'faint' : tone}`} style={{ width: `${r.weight}%` }} />
      {r.steps[0] && r.steps[0].weight >= 10 && (
        <span className="origin" aria-hidden="true">
          0%
        </span>
      )}
      <ol aria-label="The canary’s steps">
        {r.steps.map(({ weight, pauseSeconds: pause, analysis }, index) => {
          // Only a step the analysis judges is measured: a plan may hold its weight twice, a pause and then a judgement.
          const m = analysis ? r.measured.find((x) => x.weight === weight) : undefined;
          let [cls, t, glyph, how]: [string, Tone, GlyphName | '', string] = ['', 'faint', '', 'to come'];
          if (end && end.kind !== 'promoted' && weight === end.weight)
            [cls, t, glyph, how] = [
              'done cut',
              'attn',
              end.kind === 'rolled-back' ? 'cross' : 'dash',
              `${CUT[stoppedBy(end) ?? 'rolled-back']} here`,
            ];
          else if (m || (end?.kind === 'promoted' && weight === 100)) {
            const [word, tone, mark] = VERDICT[r.dryRun ? 'dry' : m ? stepPhase(m) : 'successful'];
            [cls, t, glyph, how] = ['done', tone, mark, word];
          } else if (!end && index === r.step) [cls, how] = ['now', analysis ? 'measuring now' : 'here now'];
          else if (index < r.step) [cls, how] = ['done', analysis ? 'passed' : 'not judged'];
          const held =
            weight === 100
              ? 'all'
              : !r.planned
                ? ''
                : (pause === null ? 'waits' : pause % 60 ? `${pause}s` : `${pause / 60}min`) +
                  (analysis ? '' : ' · not judged');
          return (
            <li
              key={`${weight}-${pause}-${analysis}`}
              className={`stop ${cls} tone-${t}`}
              style={{ left: `${weight}%` }}
            >
              <i>{glyph && <Glyph name={glyph} />}</i>
              <b>{weight}%</b>
              <small>{held}</small>
              <span className="sr">, {how}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const share = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
const ms = (x: number | null | undefined) => (x == null ? '—' : `${x} ms`);
const count = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString('en-GB'));
const out = (x: [number, number] | null | undefined) => (x ? `${x[0]} / ${x[1]}` : '—');

/** A measure's figure at a step, on the canary or the baseline: none for a dry run, which measured nothing. */
export function figureOf(r: Release, m: Measured, name: string, side: 'canary' | 'baseline'): string {
  const { analysis, figures } = m.stepped;
  if (r.dryRun) return '—';
  if (!figures) return name === 'enough-requests' && side === 'canary' ? count(analysis.requests) : '—';
  const f = figures[side];
  if (name === 'errors') return share(f.errorRate);
  if (name === 'latency') return ms(f.p99Ms);
  if (name === 'journeys') return out(f.journeys);
  return count(f.requests ?? (side === 'canary' ? analysis.requests : null));
}

/**
 * A measure's verdict at a step. A measure the rollback failed is failed, whatever the step's own analysis said of
 * it. A step of an analysis that names no measures (an older event's) passed or failed as a whole; a measure missing
 * from one that names them was not measured.
 */
export function phaseOf(r: Release, m: Measured, name: string): keyof typeof VERDICT {
  const { analysis } = m.stepped;
  if (r.dryRun) return 'dry';
  if (r.end?.kind === 'rolled-back' && r.end.weight === m.weight && r.end.failed.some((f) => f.name === name))
    return 'failed';
  return analysis.measures.find((x) => x.name === name)?.phase ?? (analysis.measures.length ? 'none' : analysis.phase);
}

/**
 * When the first step is measured, while the release waits for it: in flight, not a dry run, nothing measured yet,
 * and at a step the analysis judges when its pause runs out. Otherwise there is nothing to wait for, and no table.
 */
function firstMeasured(r: Release): number | undefined {
  const step = r.steps[r.step];
  return r.planned && !r.end && !r.dryRun && !r.measured.length && step?.analysis ? r.until : undefined;
}

/**
 * The measures at the latest step measured: the canary's figure, the baseline's, and the verdict. Before the first
 * step is measured, the same rows wait for it, with no figures, each measuring.
 */
function Measures({ r, m, until }: { r: Release; m: Measured | undefined; until?: number | undefined }) {
  return (
    <table className="measures">
      <caption className="label">
        {m ? (
          <>
            At the {m.weight}% step ·{' '}
            {r.dryRun ? `recorded ${clockSeconds(m.at)} by the dry run` : `measured ${clockSeconds(m.at)}`}
          </>
        ) : (
          `At the ${r.weight}% step · measuring until ${until === undefined ? '' : clockSeconds(until)}`
        )}
      </caption>
      <thead>
        <tr>
          <th className="label">Measure</th>
          <th className="label">Canary</th>
          <th className="label base">Baseline</th>
          <th className="label">Verdict</th>
        </tr>
      </thead>
      <tbody>
        {MEASURES.map(([name, label, rule]) => {
          const measure = m?.stepped.analysis.measures.find((x) => x.name === name);
          const phase = m ? phaseOf(r, m, name) : 'running';
          const [canary, baseline] = m
            ? [figureOf(r, m, name, 'canary'), figureOf(r, m, name, 'baseline')]
            : ['—', '—'];
          return (
            <tr key={name} className={phase === 'failed' ? 'failed' : ''}>
              <td>
                {label}
                <small className="rule">{rule}</small>
              </td>
              <td className="mono">
                {canary}
                <span className="base-inline">baseline {baseline}</span>
              </td>
              <td className="mono base">{baseline}</td>
              <td>
                <Verdict phase={phase} looks={phase === 'failed' ? failedLooks(r.end, name) : undefined} />
                {phase === 'error' && measure?.message && <small>{measure.message}</small>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A rollback: the measures where it failed, the analysis's words, and the ticket its signal opened. */
function Rollback({ r, onOpen }: { r: Release; onOpen: (item: string) => void }) {
  const { end } = r;
  if (end?.kind !== 'rolled-back') return null;
  const m = r.measured.at(-1);
  const label = (name: string) => MEASURES.find(([n]) => n === name)?.[1] ?? name;
  return (
    <>
      {m?.weight === end.weight ? (
        <Measures r={r} m={m} />
      ) : (
        <>
          {!m && (
            <p className="canary-note first">
              No step was measured: it rolled back {duration(end.at - r.startedAt)} into the {end.weight}% step, so the
              failed measure is the whole story.
            </p>
          )}
          <table className="measures">
            <thead>
              <tr>
                <th className="label">Failed</th>
                <th className="label">What the analysis saw</th>
                <th className="label">Verdict</th>
              </tr>
            </thead>
            <tbody>
              {end.failed.map((f, i) => {
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a measure can fail in more than one of the attempt's analyses, and an event's list never changes
                  <tr key={i} className="failed">
                    <td>
                      {label(f.name)}
                      {f.value !== null && ownWords(f.message, end.reason) && <small>{f.message}</small>}
                    </td>
                    <td>{sawOf(f, end.reason)}</td>
                    <td>
                      <Verdict phase="failed" looks={f.failures} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      <p className="words">{end.reason}</p>
      {end.ticket && (
        <p className="canary-note">
          A rollback is a signal: triage {SIGNALLED[end.ticket.how]} <Item item={end.ticket} titled onOpen={onOpen} />.
        </p>
      )}
    </>
  );
}

/**
 * An analysis that could not judge the canary: the step it could not judge, or, when the background analysis erred
 * between steps, the measures it could not take; then the analysis's words.
 */
function ErrorEnd({ r }: { r: Release }) {
  const { end } = r;
  if (end?.kind !== 'errored') return null;
  const m = r.measured.at(-1);
  const label = (name: string) => MEASURES.find(([n]) => n === name)?.[1] ?? name;
  return (
    <>
      {m?.weight === end.weight && m.stepped.analysis.phase === 'error' ? (
        <Measures r={r} m={m} />
      ) : !end.errored.length ? (
        <p className="canary-note first">
          The analysis ended in Error before any measure did: its words below are all it said.
        </p>
      ) : (
        <table className="measures">
          <thead>
            <tr>
              <th className="label">Not measured</th>
              <th className="label">The analysis’s words</th>
              <th className="label">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {end.errored.map((e) => (
              // The line names each measure once.
              <tr key={e.name}>
                <td>{label(e.name)}</td>
                <td>{ownWords(e.message, end.reason) ?? '—'}</td>
                <td>
                  <Verdict phase="error" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="words">{end.reason}</p>
    </>
  );
}

function Item({ item, titled, onOpen }: { item: Carried; titled: boolean; onOpen: (item: string) => void }) {
  return (
    <button type="button" className="linkish" onClick={() => onOpen(item.number)}>
      #{item.number}
      {titled && ` ${item.title}`}
    </button>
  );
}

/** What happens next, or what happened, in the release's own times. */
function note(r: Release): string {
  const { end } = r;
  const step = r.steps[r.step];
  if (r.dryRun)
    return 'The dry run answers for this release: its merges were never made, so nothing shipped and nothing was measured. It records each step as the line would see it, so a soak goes round.';
  if (!end) {
    if (r.paused)
      return `Martin paused the canary at ${clockSeconds(r.paused.at)}. It keeps ${r.weight}% of the traffic until he resumes it, promotes it or aborts it.`;
    if (!r.planned) return 'This release recorded no steps, so the steps measured so far stand in for them.';
    if (r.weight === 100) return 'Every step has passed: the canary takes all the traffic next.';
    if (!step || r.until === undefined)
      return `The canary holds at ${r.weight}% until someone promotes it; if a measure fails, it rolls back on its own.`;
    const next = r.steps[r.step + 1]?.weight ?? 100;
    return `${step.analysis ? 'Measuring' : 'Holding at'} the ${r.weight}% step until ${clockSeconds(r.until)}. If every measure passes, the canary ${next === 100 ? 'takes all the traffic' : `moves to ${next}%`} then; if one fails, it rolls back on its own.`;
  }
  const took = duration(end.at - r.startedAt);
  if (end.kind === 'promoted')
    return `Promoted at ${clockSeconds(end.at)}, ${took} after it started.${r.items.length ? ' Verify now asks the sense that saw each ticket whether it has cleared.' : ''}`;
  if (end.kind === 'aborted' && end.by === 'stop')
    return `Stop the line aborted the canary at ${end.weight}%, at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic. The release stays stopped until Martin retries it or a new deploy starts another; starting the line does not resume it.`;
  if (end.kind === 'aborted')
    return `Martin aborted the canary at ${end.weight}%, at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic. The release stays aborted until he retries it or a new deploy starts another.`;
  if (end.kind === 'errored')
    return `The analysis could not judge the canary at ${end.weight}%, and Argo Rollouts stopped it at ${clockSeconds(end.at)}. ${shortVersion(r.previous)}, the version before, takes all the traffic. Nothing failed, so it is no signal; the release stays stopped until Martin retries it or a new deploy starts another.`;
  return `Rolled back at ${clockSeconds(end.at)}, ${took} in. ${100 - end.weight}% of the traffic never saw it: it stayed on ${shortVersion(r.previous)}.`;
}

/** How the last release ended, in the idle line's words: "promoted", "rolled back at 25%". */
function ended(r: Release, t: number): [word: string, tone: Tone, when: string] {
  const { end } = r;
  if (!end) return ['', 'faint', ''];
  const word = end.kind === 'promoted' ? 'promoted' : `${endedWords(end)} at ${end.weight}%`;
  const today = new Date(end.at).toDateString() === new Date(t).toDateString();
  const when = today ? `at ${clock(end.at)}` : `on ${shortWhen(end.at)}`;
  if (r.dryRun) return [`${word} in a dry run`, 'faint', when];
  return [word, end.kind === 'promoted' ? 'ok' : 'attn', when];
}

/** What the step-up dialog says of each control that asks for the passkey. */
const ASKED: Partial<Record<ReleaseControl, (r: Release, c: Control) => Asked>> = {
  promote: (r, c) => ({
    title: 'Promote the canary',
    what: `${shortVersion(r.version)} moves to ${c.to}% of the traffic now.`,
    why: 'Promoting ships to more people',
  }),
  'promote-fully': (r) => ({
    title: 'Promote the canary',
    what: (
      <>
        <b>{shortVersion(r.version)} takes all the traffic now.</b> Verify then asks each ticket’s sense whether it
        cleared.
      </>
    ),
    why: 'Promoting ships to everyone',
  }),
  retry: (r) => ({
    title: 'Retry the release',
    what: `${shortVersion(r.version)}’s canary starts again from its first step.`,
    why: 'Retrying ships again',
  }),
};

/**
 * Martin's controls, under the steps and the measures: his buttons, each with the key while the passkey is not fresh
 * where it asks for it, and Abort behind a dialog; or for anyone else, the same controls as labels beside what each
 * does. Each names the release the panel shows, so the admin service acts on that one or none. What it did shows in
 * the panel as the events arrive: the kicker, the steps, the note.
 */
function Controls({ r, admin, lineStopped }: { r: Release; admin: Admin; lineStopped: boolean }) {
  const controls = controlsOf(r, lineStopped);
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const [aborting, setAborting] = useState(false);
  if (!controls.length) return null;
  if (admin.kind !== 'martin') {
    return (
      <div className="canary-controls">
        <span className="label">Martin’s controls</span>
        <dl>
          {controls.map((c) => (
            <div key={c.action}>
              <dt>
                <span className="ro">{c.label}</span>
              </dt>
              <dd>{c.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    );
  }
  const { token } = admin.session;
  const act = async (c: Control) => {
    setBusy(true);
    setRefusal(undefined);
    const asked = ASKED[c.action]?.(r, c);
    const route = c.action === 'promote-fully' ? 'promote' : c.action;
    const body = { release: r.id, ...(c.action === 'promote-fully' && { fully: true }) };
    const got = await write(`/admin/release/${route}`, body, token, asked && (() => stepUp.ask(asked)));
    setBusy(false);
    // Cancelled at the passkey: nothing was asked of the canary, and nothing to say.
    if (got.status === 403 && got.body?.refused === 'step-up') return;
    if (got.status !== 200) setRefusal(said(got));
  };
  const off = controls.find((c) => c.off)?.off;
  return (
    <div className="canary-controls">
      <span className="label">Your controls</span>
      <div className="row">
        {controls.map((c) => (
          <button
            key={c.action}
            type="button"
            className="btn"
            title={c.what}
            disabled={busy || c.off !== undefined}
            onClick={() => (c.action === 'abort' ? setAborting(true) : void act(c))}
          >
            {c.label}
            {c.stepUp && !stepUp.fresh && <Key />}
          </button>
        ))}
        {off && <span className="help">{off}</span>}
      </div>
      {refusal && (
        <p className="canary-refusal" role="alert">
          {refusal}
        </p>
      )}
      {aborting && (
        <Dialog
          title="Abort the canary"
          onClose={() => setAborting(false)}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setAborting(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn attn"
                onClick={() => {
                  setAborting(false);
                  const abort = controls.find((c) => c.action === 'abort');
                  if (abort) void act(abort);
                }}
              >
                Abort
              </button>
            </>
          }
        >
          <p>
            {shortVersion(r.previous)}, the version before, takes all the traffic at once. Nothing failed, so it opens
            no ticket
            {r.items.length
              ? `, and ${r.items.map((i) => `#${i.number}`).join(' and ')} waits for your retry or the next deploy`
              : ''}
            .
          </p>
        </Dialog>
      )}
    </div>
  );
}

interface CanaryProps {
  view: CanaryView;
  t: number;
  onOpen: (item: string) => void;
  /** Who is looking: Martin's controls are his buttons, and everyone else's labels. */
  admin: Admin;
  /** Whether the line is stopped: a stopped line starts no canary, so Retry waits for it to start. */
  lineStopped: boolean;
}

export function Canary({ view, t, onOpen, admin, lineStopped }: CanaryProps) {
  if (view.state !== 'shown') {
    const r = view.state === 'idle' ? view.release : undefined;
    const [word, tone, when] = r ? ended(r, t) : [];
    return (
      <section className="canary idle" aria-labelledby="canary-title">
        <h2 id="canary-title">Canary</h2>
        {r?.end ? (
          <p>
            <span className="out tone-faint">
              <span className="dot" aria-hidden="true" />
              No release in flight
            </span>{' '}
            The last, <b className="mono">{shortVersion(r.version)}</b>, was{' '}
            <span className={`said tone-${tone}`}>{word}</span> {when} carrying{' '}
            {r.items.length
              ? r.items.map((item) => <Item key={item.number} item={item} titled={false} onOpen={onOpen} />)
              : 'no work item'}{' '}
            · release {r.id}
          </p>
        ) : (
          <p>
            No release yet. Each deploy Martin merges goes out here as a canary, beside the version it would replace.
          </p>
        )}
      </section>
    );
  }
  const r = view.release;
  const [word, tone, dot] = standing(r);
  const { items, image } = r;
  const title = items[0]
    ? items[0].title + (items.length > 1 ? ` and ${items.length - 1} more` : '')
    : 'Carries no work item';
  const m = r.measured.at(-1);
  const first = firstMeasured(r);
  const right =
    r.end?.kind === 'rolled-back' ? (
      <Rollback r={r} onOpen={onOpen} />
    ) : r.end?.kind === 'errored' ? (
      <ErrorEnd r={r} />
    ) : (
      (m || first !== undefined) && <Measures r={r} m={m} until={first} />
    );
  return (
    <section className="canary" aria-labelledby="canary-title">
      <div className="canary-head">
        <div>
          <p className="kick">
            <span className={`out tone-${tone}`}>
              <span className={`dot ${dot}`} aria-hidden="true" />
              {word}
            </span>
            {r.dryRun && <span className="pill-sample">Dry run</span>}
          </p>
          <h2 id="canary-title">{title}</h2>
          <p className="carries">
            {items.length ? (
              <>
                Carries
                {items.map((item) => (
                  <Item key={item.number} item={item} titled={items.length > 1} onOpen={onOpen} />
                ))}
              </>
            ) : (
              'Martin’s own commits or a dependency update: a release with no work item is on the line, not the reel, unless it rolls back.'
            )}
          </p>
        </div>
        <p className="rel-id mono">
          Release {r.id}
          <br />
          <b>
            {shortVersion(r.previous)} → {shortVersion(r.version)}
          </b>
          {r.commit && !isCommit(r.version) && ` · ${r.commit.slice(0, 7)}`}
          <br />
          {image
            ? `${image.digest.slice(0, 11)}…${image.digest.slice(-4)}${image.signed ? ' · signed' : ''}${image.admitted ? ' · admitted' : ''}`
            : 'no image: nothing shipped'}
        </p>
      </div>
      <div className="canary-body">
        <div>
          <Steps r={r} tone={tone} />
          <p className="canary-note">{note(r)}</p>
        </div>
        {right && <div>{right}</div>}
      </div>
      <Controls r={r} admin={admin} lineStopped={lineStopped} />
      <p className="help">
        The canary moves on by itself while every measure passes, and rolls back by itself the moment one fails. Nobody
        needs to press anything.
      </p>
    </section>
  );
}
