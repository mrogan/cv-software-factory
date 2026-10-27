/**
 * An improvement's flag on its sheet, in place of Release and Verify: the flag's name and the stage it is at, in the
 * stages' words, its slider read-only, and a block per stage it reached, newest first, the older ones folded, each drawn
 * as a release's block is.
 *
 * What Verify finds at each stage comes in its own events: today the sheet draws its comparison at Share
 * (`flag.compared`). The probes' pictures of the pages off and on at Checks, and the device check at Preview, are
 * drawn once Verify records them; until then each block says what the stage does, and that its checks are to come.
 */
import { clock, shortVersion, shortWhen } from '../format.ts';
import { previewHref } from '../profile.ts';
import { comparedWords, type FlagBlock, type FlagSheet, STAGE_NAME, stageSays } from '../projection/index.ts';
import type { Tone } from './Canary.tsx';
import { FlagSlider, stageWords } from './Flags.tsx';

const lower = (text: string) => `${text[0]?.toLowerCase() ?? ''}${text.slice(1)}`;

/** A block's word, in its tone: how the stage stands. */
function wordOf(block: FlagBlock): [string, Tone] {
  if (block.kind === 'released') return ['Off', 'faint'];
  const { stage } = block;
  if (stage.stage === 'off') return ['Turned off', 'faint'];
  if (stage.stage === 'share') {
    if (block.compared) return block.compared.outcome === 'passed' ? ['Passed', 'ok'] : ['Failed', 'attn'];
    return block.current ? ['Comparing', 'signal'] : ['Stopped', 'faint'];
  }
  if (stage.stage === 'everyone') return block.current ? ['On for everyone', 'ok'] : ['Widened past', 'faint'];
  return block.current ? ['At it now', 'signal'] : ['Widened past', 'faint'];
}

/** How Martin made the move, in a few words: "widened by Martin, with his passkey". */
function byWords(block: Extract<FlagBlock, { kind: 'staged' }>): string {
  const how = {
    'flag.to-checks': 'Widened by Martin',
    'flag.widen': 'Widened by Martin',
    'flag.back-on': 'Turned back on by Martin',
    'flag.narrow': 'Narrowed by Martin',
    'flag.off': 'Turned off by Martin',
  }[block.action];
  return `${how}${block.from ? ` from ${stageWords(block.from)}` : ''}${block.passkey ? ', with his passkey' : ''}`;
}

function Body({ block, flag, app }: { block: FlagBlock; flag: FlagSheet; app: string | undefined }) {
  const { row } = flag;
  if (block.kind === 'released') {
    return (
      <p className="rel-end">
        Shipped in {shortVersion(block.version)} with the flag off, so nobody saw a change: release {block.release},
        promoted at {clock(block.at)}. The flag waited for Martin to widen it.
      </p>
    );
  }
  const { stage } = block;
  switch (stage.stage) {
    case 'off':
      return (
        <>
          {block.reason && <p className="words">“{block.reason}”</p>}
          <p className="rel-end">
            {byWords(block)}, for everyone, a preview too. The admin service asks the app for the flags it holds, and
            tells his phone if it hasn’t taken it within a minute.{' '}
            {row.backOn
              ? 'It was on for everyone, so it can go straight back from Controls.'
              : `Its code stays in the app, off, and nothing was rolled back. To try again, Martin asks with the “+”.`}
          </p>
        </>
      );
    case 'checks':
      return (
        <p className="rel-end">
          {byWords(block)}. On for the factory’s own checks, by the header only they can send. The probes’ pictures of
          the pages the spec names, off and on, and the journeys’ result with it on, are drawn here once Verify records
          them: the probes are written from the spec, blind, and know no new feature, so the pictures are for Martin to
          judge when he widens, and the spec’s criteria were proved by the pull request’s own tests.
        </p>
      );
    case 'preview':
      return (
        <>
          <p className="rel-end">
            {byWords(block)}. Also on for anyone who asks to preview it, in their own browser. A probe’s preview, and
            the cookie the device check finds, are drawn here once Verify records them.
          </p>
          {block.current && app && !row.turnedOff && (
            <p className="rel-end">
              <a href={previewHref(app, row.name)} target="_blank" rel="noopener">
                Preview it on the app<span aria-hidden="true"> ↗</span>
                <span className="sr"> (opens a new tab)</span>
              </a>
              : it sets the same cookie in your browser, for a day, and shows you only this flag.
            </p>
          )}
        </>
      );
    case 'share': {
      const { compared } = block;
      return (
        <>
          <p className="rel-end">
            {byWords(block)}. Also on for {stage.share}% of the traffic generator’s requests. Verify compares the two
            sides from the generator’s own figures, by the id each request carried, and works out each id’s side with
            flagd’s own rule: the app labels nothing it is judged on.
          </p>
          {compared && (
            <table className="measures figs">
              <thead>
                <tr>
                  <th className="label">Measure</th>
                  <th className="label num">Flag on</th>
                  <th className="label num base">Flag off</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Requests</td>
                  <td className="num">{compared.sides.on.requests}</td>
                  <td className="num base">{compared.sides.off.requests}</td>
                </tr>
                <tr>
                  <td>
                    Errors<small>share of 5xx answers</small>
                  </td>
                  <td className="num">{percent(compared.sides.on.errorRate)}</td>
                  <td className="num base">{percent(compared.sides.off.errorRate)}</td>
                </tr>
                <tr>
                  <td>
                    Latency<small>p99</small>
                  </td>
                  <td className="num">{ms(compared.sides.on.p99Ms)}</td>
                  <td className="num base">{ms(compared.sides.off.p99Ms)}</td>
                </tr>
              </tbody>
            </table>
          )}
          <p className="rel-end">
            {compared
              ? `Judged at ${clock(compared.at)}, with the canary’s thresholds: ${comparedWords(compared)}.${compared.reason ? ` ${compared.reason}` : ''}${compared.setAsideMinutes ? ` ${compared.setAsideMinutes} minutes a canary was in flight are set aside: its two versions would mix the sides.` : ''}`
              : block.current
                ? 'Verify judges once each side has enough requests. Everyone can be taken once the comparison has passed.'
                : 'Moved on before Verify had judged it.'}
          </p>
        </>
      );
    }
    case 'everyone':
      return (
        <p className="rel-end">
          {byWords(block)}. On for every visitor. Turning it off is still one press in Controls, and reaches the app in
          seconds, with no deploy.
        </p>
      );
  }
}

const percent = (rate: number | null) => (rate === null ? '—' : `${(rate * 100).toFixed(2)}%`);
const ms = (value: number | null) => (value === null ? '—' : `${value} ms`);

function Block({
  block,
  flag,
  app,
  folded,
}: {
  block: FlagBlock;
  flag: FlagSheet;
  app: string | undefined;
  folded: boolean;
}) {
  const [word, tone] = wordOf(block);
  const label =
    block.kind === 'released'
      ? `Released · ${shortVersion(block.version)}`
      : block.stage.stage === 'share'
        ? `Share · ${block.stage.share}%`
        : STAGE_NAME[block.stage.stage];
  const head = (
    <>
      <span className="label">
        {label} · {shortWhen(block.at)}
      </span>
      <span className={`out tone-${tone}`}>
        <span className="dot" aria-hidden="true" />
        {word}
      </span>
    </>
  );
  if (folded)
    return (
      <details className="rel">
        <summary className="rel-head">
          {head}
          <span className="more">Show this stage</span>
        </summary>
        <Body block={block} flag={flag} app={app} />
      </details>
    );
  return (
    <article className="rel">
      <div className="rel-head">{head}</div>
      <Body block={block} flag={flag} app={app} />
    </article>
  );
}

export function FlagSection({ flag, app }: { flag: FlagSheet; app: string | undefined }) {
  const { row } = flag;
  return (
    <section className="sec">
      <h3>The flag</h3>
      <p className="help">
        <code className="flagname">{row.name}</code>{' '}
        {row.turnedOff
          ? `is off, turned off by Martin.`
          : `is at ${stageWords(row.stage)}: ${lower(stageSays(row.stage))}`}{' '}
        Each stage is Martin’s, from Controls; widening asks for his passkey.
      </p>
      <FlagSlider row={row} />
      <div className="rels">
        {flag.blocks.map((block, i) => (
          <Block key={`${block.kind}-${block.at}`} block={block} flag={flag} app={app} folded={i > 0} />
        ))}
      </div>
      <p className="source">
        <span>Martin’s stages, as the admin service records each move, and Verify’s comparisons at Share.</span>
      </p>
    </section>
  );
}
