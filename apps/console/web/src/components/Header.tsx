import type { Autonomy } from '@software-factory/events';
import type { Admin } from '../admin.ts';
import { duration } from '../format.ts';
import type { Header as LineState, Score } from '../projection/index.ts';
import type { Theme } from '../settings.ts';
import type { Connection } from '../source.ts';
import { Account } from './Account.tsx';
import { Mark } from './Mark.tsx';
import { StepUpPill } from './StepUp.tsx';

const AUTONOMY: Record<Autonomy, string> = { supervised: 'Supervised', guarded: 'Guarded', 'lights-out': 'Lights-out' };

/** Whether the line runs, in words and a dot that never carries the meaning alone. */
export function LineStatus({ line, connection }: { line: LineState; connection: Connection }) {
  if (connection === 'loading' || connection === 'failed') {
    return (
      <>
        <span className="dot tone-faint" aria-hidden="true" />
        {connection === 'loading' ? 'Connecting to the factory' : 'Can’t reach the factory'}
      </>
    );
  }
  if (connection === 'reconnecting') {
    return (
      <>
        <span className="dot tone-signal blink" aria-hidden="true" />
        Reconnecting
      </>
    );
  }
  if (line.stopped !== undefined) {
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        Line stopped
      </>
    );
  }
  if (!line.running) {
    return (
      <>
        <span className="dot tone-faint" aria-hidden="true" />
        Line not started
      </>
    );
  }
  // A spend cap is a guardrail at work: the header says it first, by the ember ring that asks a person to look.
  if (line.capped) {
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        Line running · <b className="capped">spend cap reached</b>
      </>
    );
  }
  if (line.waiting) {
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        Line running · <b className="capped">agents waiting for a model</b>
      </>
    );
  }
  return (
    <>
      <span className="dot tone-ok blink" aria-hidden="true" />
      Line running{line.autonomy && ` · ${AUTONOMY[line.autonomy]}`}
    </>
  );
}

/**
 * The scoreboard beside the app's name: its three figures as it last published them, or that it is off. It never
 * names a ticket, and draws nothing when it has never published.
 */
export function Scoreboard({ score, sample }: { score: Score | undefined; sample: boolean }) {
  if (!score) return null;
  if (!score.keyed) {
    return (
      <p className="score-off">
        <b>Scoreboard off</b> <span>This copy of the factory has no answer key, so it counts nothing.</span>
      </p>
    );
  }
  return (
    <div className="score-wrap">
      {sample && <span className="pill-sample">Sample</span>}
      {/* biome-ignore lint/a11y/useSemanticElements: a fieldset holds a form's controls, and these are figures */}
      <div className="score" role="group" aria-label="Scoreboard: seeded and injected defects">
        <div>
          <b>{score.found}</b>
          <span>found</span>
        </div>
        <div>
          <b className={score.verified ? 'ok' : undefined}>{score.verified}</b>
          <span>verified fixed</span>
        </div>
        <div>
          {score.medianMs === null ? (
            <b className="none">
              <span aria-hidden="true">—</span>
              <span className="sr">none yet</span>
            </b>
          ) : (
            <b>{duration(score.medianMs)}</b>
          )}
          <span>median to verified</span>
        </div>
      </div>
    </div>
  );
}

interface HeaderProps {
  line: LineState;
  connection: Connection;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  motion: boolean;
  onMotion: (on: boolean) => void;
  admin: Admin;
  /** Martin, signed in, sees the console as a visitor does (`Preview.tsx`). */
  previewing: boolean;
  onPreview: () => void;
}

export function Header({
  line,
  connection,
  theme,
  onTheme,
  motion,
  onMotion,
  admin,
  previewing,
  onPreview,
}: HeaderProps) {
  return (
    <header className="top">
      <div className="wrap">
        {/* Named in the words it shows, in order, at a width that shows its byline and at one that hides it. */}
        <a className="brand" href="#top" aria-label="Software Factory: Martin Rogan, a live CV">
          <Mark />
          <span className="rule" aria-hidden="true" />
          <span>
            <b>Software Factory</b> <small>Martin Rogan · a live CV</small>
          </span>
        </a>
        <div className="top-right">
          <span className="status">
            <LineStatus line={line} connection={connection} />
          </span>
          <fieldset className="seg" aria-label="Theme">
            <button type="button" aria-pressed={theme === 'paper'} onClick={() => onTheme('paper')}>
              PAPER
            </button>
            <button type="button" aria-pressed={theme === 'ink'} onClick={() => onTheme('ink')}>
              INK
            </button>
          </fieldset>
          <fieldset className="seg" aria-label="Motion">
            <button type="button" aria-pressed={motion} onClick={() => onMotion(true)}>
              MOTION
            </button>
            <button type="button" aria-pressed={!motion} onClick={() => onMotion(false)}>
              STILL
            </button>
          </fieldset>
          {admin.kind === 'martin' && previewing && <span className="pill-visitor">VISITOR VIEW</span>}
          {admin.kind === 'martin' && !previewing && (
            <>
              <StepUpPill />
              {/* On a phone it is in the account menu instead. */}
              <button type="button" className="btn preview-btn" onClick={onPreview}>
                Preview as visitor
              </button>
              <Account session={admin.session} onPreview={onPreview} />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
