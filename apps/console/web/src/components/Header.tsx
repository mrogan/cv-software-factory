import { useEffect, useId, useRef, useState } from 'react';
import { type Admin, said, write } from '../admin.ts';
import { AUTONOMY, duration } from '../format.ts';
import type { Header as LineState, Score } from '../projection/index.ts';
import type { Theme } from '../settings.ts';
import type { Connection } from '../source.ts';
import { Account } from './Account.tsx';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';
import { Mark } from './Mark.tsx';
import { Key, StepUpPill, useStepUp } from './StepUp.tsx';

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
    // Martin's reason, as everyone reads it: in full on a hover, and cut short where the header has no room.
    return (
      <>
        <span className="dot tone-attn ring" aria-hidden="true" />
        <span>
          Line stopped · “
          <span className="why" title={line.stopped}>
            {line.stopped}
          </span>
          ”
        </span>
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
      Line running · {AUTONOMY[line.autonomy]}
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

/** The most a reason may be, as `line.stopped` and `line.started` take it. */
const REASON = 200;

/**
 * Stop the line, in `attn`, always one press away; while it is stopped, Start the line in its place, in `signal`, with
 * the key while the passkey is not fresh. Each opens its dialog, which asks for a reason, for the audit log.
 */
function LineButton({ line, token }: { line: LineState; token: string }) {
  const stopped = line.stopped !== undefined;
  const stepUp = useStepUp();
  const [open, setOpen] = useState<'stop' | 'start' | undefined>(undefined);
  return (
    <>
      <button
        type="button"
        className={`btn line-btn ${stopped ? 'primary' : 'attn'}`}
        onClick={() => setOpen(stopped ? 'start' : 'stop')}
      >
        {stopped ? (
          <>
            Start<span className="line-word"> the line</span>
            {!stepUp.fresh && <Key />}
          </>
        ) : (
          <>
            <Glyph name="cord" />
            Stop<span className="line-word"> the line</span>
          </>
        )}
      </button>
      {open && <LineDialog kind={open} token={token} onClose={() => setOpen(undefined)} />}
    </>
  );
}

/**
 * Stopping or starting the line, with Martin's reason. Stopping never asks for the passkey; starting does, and its
 * button runs the passkey sheet itself ("Use your passkey and start") when the service asks for it. What the service
 * says shows here, where he pressed: a refusal, or, once the line has stopped, that a canary in flight was not aborted.
 */
function LineDialog({ kind, token, onClose }: { kind: 'stop' | 'start'; token: string; onClose: () => void }) {
  const stepUp = useStepUp();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; done: boolean } | undefined>(undefined);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );
  const stop = kind === 'stop';

  const act = async () => {
    const why = reason.trim();
    if (!why) return field.current?.focus();
    if (busy) return;
    setBusy(true);
    setAnswer(undefined);
    let refused: string | undefined;
    const prove = async () => {
      refused = await stepUp.prove();
      return refused === undefined;
    };
    const got = await write(`/admin/line/${kind}`, { reason: why }, token, stop ? undefined : prove);
    if (!live.current) return;
    setBusy(false);
    if (got.status !== 200) return setAnswer({ text: refused ?? said(got), done: false });
    // Stopped, with a canary in flight it could not abort: Martin must know, and that `make stop-the-line` will.
    if (typeof got.body?.warning === 'string') return setAnswer({ text: got.body.warning, done: true });
    onClose();
  };

  const done = answer?.done === true;
  const label = stop ? 'Stop the line' : stepUp.fresh ? 'Start the line' : 'Use your passkey and start';
  return (
    <Dialog
      title={stop ? 'Stop the line' : 'Start the line'}
      onClose={onClose}
      actions={
        done ? (
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={`btn ${stop ? 'attn' : 'primary'}`}
              disabled={!reason.trim()}
              aria-disabled={busy || undefined}
              onClick={() => void act()}
            >
              {label}
              {!stop && !stepUp.fresh && <Glyph name="key" className="glyph key" />}
            </button>
          </>
        )
      }
    >
      {stop ? (
        <p>
          Every agent stops at the end of its step, nothing new is taken, and a canary in flight is aborted: the version
          before takes all the traffic. <code>make stop-the-line</code> does the same when the console can’t.
        </p>
      ) : (
        <p>
          Agents take work again, as What the line takes says. A release stopped with the line stays stopped until you
          retry it.
        </p>
      )}
      {!done && (
        <div className="reason">
          <label className="label" htmlFor={`${id}-reason`}>
            Reason
          </label>
          <textarea
            ref={field}
            id={`${id}-reason`}
            className="field"
            maxLength={REASON}
            rows={2}
            required
            value={reason}
            placeholder="Why, for the audit log"
            onChange={(event) => setReason(event.currentTarget.value)}
          />
          <span className="help">
            Visitors see your reason, with anything shaped like a secret left out.{' '}
            <span className="chars">
              {reason.length} / {REASON}
            </span>
          </span>
        </div>
      )}
      {!stop && !stepUp.fresh && !done && <p className="help">Starting the line asks for your passkey again.</p>}
      {answer && (
        <p className="dialog-refusal" role="alert">
          {answer.text}
        </p>
      )}
    </Dialog>
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
              <LineButton line={line} token={admin.session.token} />
              <Account session={admin.session} onPreview={onPreview} />
            </>
          )}
        </div>
      </div>
    </header>
  );
}
