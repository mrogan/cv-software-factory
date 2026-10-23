/**
 * Martin's account button, at the right of the header while he is signed in, and its menu: who is signed in, since
 * when and until when, Preview as visitor, then signing out here or everywhere. Escape or a click outside closes it.
 */
import { useEffect, useRef, useState } from 'react';
import { doorHref, leave, post, type Session, said } from '../admin.ts';
import { clock } from '../format.ts';
import { StepUpLine } from './StepUp.tsx';

export function Account({ session, onPreview }: { session: Session; onPreview: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOut = async (everywhere: boolean) => {
    setBusy(true);
    setRefusal(undefined);
    const got = await post(everywhere ? '/admin/sign-out-everywhere' : '/admin/sign-out', {}, session.token);
    // Signed out, or the session had already ended (signed out elsewhere, or its passkey revoked): either way this
    // browser holds none now, though only a sign-out that went through ended every other.
    if (got.status === 200 || got.status === 401) {
      leave(doorHref('sign-in', got.status === 200 && everywhere ? 'everywhere' : 'here'));
      return;
    }
    setBusy(false);
    setRefusal(said(got));
  };

  return (
    <span className="account" ref={root}>
      <button
        type="button"
        className="account-btn"
        ref={button}
        aria-expanded={open}
        aria-controls="account-menu"
        onClick={() => setOpen(!open)}
      >
        <span className="me" aria-hidden="true">
          M
        </span>
        <span className="name">Martin</span>
      </button>
      <div className="menu" id="account-menu" hidden={!open}>
        <div className="who">
          Martin Rogan
          <small>
            Signed in with a passkey at {clock(Date.parse(session.signedInAt))}
            <br />
            The session ends at {clock(Date.parse(session.expiresAt))}
            <StepUpLine />
          </small>
        </div>
        <button type="button" onClick={onPreview}>
          Preview as visitor
        </button>
        <hr />
        <button type="button" disabled={busy} onClick={() => void signOut(false)}>
          Sign out
        </button>
        <button type="button" disabled={busy} onClick={() => void signOut(true)}>
          Sign out everywhere <small className="after">every device</small>
        </button>
        {refusal && (
          <p className="menu-refusal" role="alert">
            {refusal}
          </p>
        )}
      </div>
    </span>
  );
}
