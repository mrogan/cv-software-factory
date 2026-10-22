/**
 * The passkey, again (step-up). Every action `policy/access.ts` marks as loosening a control, raising spend, promoting
 * something or overriding a guardrail needs Martin's passkey given in the last five minutes, which the admin service
 * enforces. The console draws a key after such an action's label while the passkey is not fresh; pressing it opens
 * "Your passkey, again", with the action's name as its title, what will happen in a ruled box, and why it asks. Once
 * given, the header shows a pill, "Passkey given · 5min", counting down (in the account menu on a phone), the keys
 * disappear, and those actions act at once until it runs out.
 *
 * The page's own count is a convenience: the service decides. A write it refuses for want of the passkey asks for it
 * here and is sent again (`write` in `admin.ts`), however fresh the page thought it was.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FRESH_MINUTES } from '../access.ts';
import { post, type Session, said } from '../admin.ts';
import { Dialog } from './Dialog.tsx';
import { Glyph } from './Glyph.tsx';

/** What the step-up dialog says of an action: its name, what will happen, and why it asks ("Promoting ships to everyone"). */
export interface Asked {
  title: string;
  what: ReactNode;
  why: string;
}

export interface StepUp {
  /** Whether the passkey was given in the last five minutes, as far as the page knows. */
  fresh: boolean;
  /** Until when, if it is. */
  until: number | undefined;
  /** Asks for the passkey, for this action: true once given, false if Martin cancels. */
  ask(asked: Asked): Promise<boolean>;
}

const NONE: StepUp = { fresh: false, until: undefined, ask: async () => false };
const StepUpContext = createContext<StepUp>(NONE);

/** The passkey's freshness, and the way to ask for it, anywhere under Martin's console. */
export const useStepUp = () => useContext(StepUpContext);

/** Holds the passkey's freshness for a session, and draws the step-up dialog when an action asks for it. */
export function StepUpProvider({ session, children }: { session: Session; children: ReactNode }) {
  const [until, setUntil] = useState<number | undefined>(() =>
    session.steppedUp && session.steppedUpAt ? Date.parse(session.steppedUpAt) + FRESH_MINUTES * 60_000 : undefined,
  );
  const [now, setNow] = useState(() => Date.now());
  // The pill counts down in whole minutes, so a look every few seconds is enough, and none once it has run out.
  useEffect(() => {
    if (until === undefined || now >= until) return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [until, now]);
  const [asking, setAsking] = useState<{ asked: Asked; answer: (given: boolean) => void } | undefined>(undefined);
  const ask = useCallback(
    (asked: Asked) =>
      new Promise<boolean>((resolve) => {
        setAsking({ asked, answer: resolve });
      }),
    [],
  );
  const answered = (given: boolean) => {
    if (given) {
      setUntil(Date.now() + FRESH_MINUTES * 60_000);
      setNow(Date.now());
    }
    asking?.answer(given);
    setAsking(undefined);
  };
  const fresh = until !== undefined && now < until;
  const value = useMemo(() => ({ fresh, until: fresh ? until : undefined, ask }), [fresh, until, ask]);
  return (
    <StepUpContext.Provider value={value}>
      {children}
      {asking && <StepUpDialog asked={asking.asked} token={session.token} onAnswer={answered} />}
    </StepUpContext.Provider>
  );
}

/**
 * "Your passkey, again": the browser's own passkey sheet, for the session's own passkey, through the admin service's
 * ceremony. The ceremony's code arrives when it is first asked for.
 */
function StepUpDialog({ asked, token, onAnswer }: { asked: Asked; token: string; onAnswer: (given: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const give = async () => {
    setBusy(true);
    setRefusal(undefined);
    const fail = (text: string) => {
      if (!live.current) return;
      setRefusal(text);
      setBusy(false);
    };
    const options = await post('/admin/step-up/options', {}, token);
    if (options.status !== 200 || !options.body) return fail(said(options));
    const { startAuthentication } = await import('@simplewebauthn/browser');
    let response: Awaited<ReturnType<typeof startAuthentication>>;
    try {
      response = await startAuthentication({ optionsJSON: options.body as never });
    } catch (error) {
      // The sheet was closed, or this device holds no passkey for the factory: the browser does not say which.
      return fail(
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'No passkey was used: the sheet was closed, or this device has none for the factory.'
          : 'The browser could not use a passkey here.',
      );
    }
    const got = await post('/admin/step-up', { response }, token);
    if (got.status === 200) return onAnswer(true);
    fail(said(got));
  };

  return (
    <Dialog
      title={asked.title}
      kicker={
        <>
          <Glyph name="key" className="glyph key" />
          <span className="label">Your passkey, again</span>
        </>
      }
      onClose={() => onAnswer(false)}
      actions={
        <>
          <button type="button" className="btn" onClick={() => onAnswer(false)}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void give()}>
            Use your passkey
          </button>
        </>
      }
    >
      <div className="what">{asked.what}</div>
      <p>
        {asked.why}, so it needs your passkey again. Once given, it stays fresh for five minutes, for this and anything
        else that asks.
      </p>
      {refusal && (
        <p className="dialog-refusal" role="alert">
          {refusal}
        </p>
      )}
    </Dialog>
  );
}

/** The key after an action's label, while the passkey is not fresh: a screen reader hears that it asks for it. */
export function Key() {
  return (
    <>
      <Glyph name="key" className="glyph key" />
      <span className="sr"> (asks for your passkey)</span>
    </>
  );
}

/** Whole minutes left, never nought while any is: "5min". */
const left = (until: number) => `${Math.max(1, Math.ceil((until - Date.now()) / 60_000))}min`;

/** The header's pill while the passkey is fresh: "Passkey given · 5min", counting down. Nothing otherwise. */
export function StepUpPill() {
  const { until } = useStepUp();
  if (until === undefined) return null;
  return (
    <span className="fresh" role="status">
      <Glyph name="key" className="glyph key" />
      <span className="long">Passkey given · </span>
      {left(until)}
      <span className="sr"> left</span>
    </span>
  );
}

/** The same, as a line in the account menu, where a phone shows it. */
export function StepUpLine() {
  const { until } = useStepUp();
  if (until === undefined) return null;
  return (
    <>
      <br />
      Passkey given again: {left(until)} left
    </>
  );
}
