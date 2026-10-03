import type { Autonomy } from '@software-factory/events';
import type { Header as LineState } from '../projection/index.ts';
import type { Theme } from '../settings.ts';
import { Mark } from './Mark.tsx';

const AUTONOMY: Record<Autonomy, string> = { supervised: 'Supervised', guarded: 'Guarded', 'lights-out': 'Lights-out' };

/** Whether the line runs, in words and a dot that never carries the meaning alone. */
export function LineStatus({ line }: { line: LineState }) {
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
  return (
    <>
      <span className="dot tone-ok blink" aria-hidden="true" />
      Line running{line.autonomy && ` · ${AUTONOMY[line.autonomy]}`}
    </>
  );
}

interface HeaderProps {
  line: LineState;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  motion: boolean;
  onMotion: (on: boolean) => void;
}

export function Header({ line, theme, onTheme, motion, onMotion }: HeaderProps) {
  return (
    <header className="top">
      <div className="wrap">
        <a className="brand" href="#top" aria-label="Software Factory, by Martin Rogan">
          <Mark />
          <span className="rule" aria-hidden="true" />
          <span>
            <b>Software Factory</b>
            <small>Martin Rogan · a live CV</small>
          </span>
        </a>
        <div className="top-right">
          <span className="status">
            <LineStatus line={line} />
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
        </div>
      </div>
    </header>
  );
}
