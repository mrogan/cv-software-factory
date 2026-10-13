/**
 * The Canary panel: the release in flight against the version it would replace, for everyone, full width under the
 * line. It is always there; idle, it is one line.
 */
import { capital, clock, clockSeconds, duration, isCommit, shortVersion, shortWhen } from '../format.ts';
import type { CanaryView, Carried, Measured, Release } from '../projection/index.ts';
import { endedWords, MEASURES, ownWords, SIGNALLED, sawOf } from '../projection/release.ts';
import { Glyph, type GlyphName } from './Glyph.tsx';

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

export function Verdict({ phase }: { phase: keyof typeof VERDICT }) {
  const [word, tone, glyph] = VERDICT[phase];
  return (
    <span className={`v tone-${tone}`}>
      <Glyph name={glyph} />
      {word}
    </span>
  );
}

/** How the release stands, as the kicker says it, in its tone. */
export function standing(r: Release): [word: string, tone: Tone, dot: string] {
  const { end, weight } = r;
  if (!end) {
    const word = weight ? `Canary · ${weight}%` : 'Canary · starting';
    return r.dryRun ? [`${word}, as the dry run records it`, 'faint', ''] : [`${word} of traffic`, 'signal', 'blink'];
  }
  const [word, tone]: [string, Tone] =
    end.kind === 'promoted'
      ? ['Promoted · all traffic', 'ok']
      : [`${capital(endedWords(end))} at ${end.weight}%`, 'attn'];
  return r.dryRun ? [`${word}, as the dry run records it`, 'faint', ''] : [word, tone, tone === 'attn' ? 'ring' : ''];
}

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
              end.kind === 'aborted' ? 'dash' : 'cross',
              `${end.kind === 'aborted' ? (end.by === 'stop' ? 'stopped' : 'aborted') : 'rolled back'} here`,
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
                : (pause === null ? 'waits' : pause % 60 ? `${pause} s` : `${pause / 60} min`) +
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

/** The measures at the latest step measured: the canary's figure, the baseline's, and the verdict. */
function Measures({ r, m }: { r: Release; m: Measured }) {
  const { analysis } = m.stepped;
  return (
    <table className="measures">
      <caption className="label">
        At the {m.weight}% step ·{' '}
        {r.dryRun ? `recorded ${clockSeconds(m.at)} by the dry run` : `measured ${clockSeconds(m.at)}`}
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
          const measure = analysis.measures.find((x) => x.name === name);
          const phase = phaseOf(r, m, name);
          const [canary, baseline] = [figureOf(r, m, name, 'canary'), figureOf(r, m, name, 'baseline')];
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
                <Verdict phase={phase} />
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
                      <Verdict phase="failed" />
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

export function Canary({ view, t, onOpen }: { view: CanaryView; t: number; onOpen: (item: string) => void }) {
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
  const right = r.end?.kind === 'rolled-back' ? <Rollback r={r} onOpen={onOpen} /> : m && <Measures r={r} m={m} />;
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
      <p className="help">
        The canary moves on by itself while every measure passes, and rolls back by itself the moment one fails. Nobody
        needs to press anything.
      </p>
    </section>
  );
}
