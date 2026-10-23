/**
 * Needs you, the left of the bottom row: one card per hold, the line's and triage's, oldest first, so what has waited
 * longest is on top. Each says what the hold is, shows the one piece of evidence that explains it, and lists each
 * answer it takes beside what that answer does, from the line's own table. The buttons are all outlined: the console
 * does not suggest an answer. Under the cards, Martin's answers today.
 *
 * For Martin, each answer is a write to the admin service, naming the hold the card showed, so the service answers
 * that hold or none. Approving a guardrail's hold asks for his passkey again (the key shows while it is not fresh);
 * the service decides, from the stored hold. An answered card moves to Answered today as its event arrives: there is
 * no toast. A visitor sees the same cards, titled Waiting on Martin, each answer a label beside what it does.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { type Admin, said, write } from '../admin.ts';
import { clock } from '../format.ts';
import { type Need, type NeedsView, stageName } from '../projection/index.ts';
import { Key, useStepUp } from './StepUp.tsx';

/** The most an answer in words may say, as the admin service and the event take it. */
const WORDS = 300;

const ROUTE = { approved: 'approve', rejected: 'reject', answered: 'answer' } as const;

function Evidence({ need }: { need: Need }) {
  const { evidence, link } = need;
  return (
    <>
      {evidence.kind === 'output' ? (
        <p className="words">
          {evidence.heading}
          {'\n'}
          {evidence.text}
        </p>
      ) : evidence.kind === 'question' ? (
        <p className="ev">
          {evidence.before} <q>{evidence.question}</q>
        </p>
      ) : (
        <p className="ev">{evidence.text}</p>
      )}
      {link && (
        <p className="ev">
          <a href={link.href}>{link.label}</a>
        </p>
      )}
    </>
  );
}

/** A card, read only: each answer a label beside what it does, and who answers. */
function ReadOnlyCard({ need, onOpen }: { need: Need; onOpen: (item: string) => void }) {
  const id = useId();
  return (
    <article className="need" aria-labelledby={id}>
      <Kick need={need} />
      <h3 id={id}>{need.title}</h3>
      <Evidence need={need} />
      <div className="answers">
        {need.answers.map((row) => (
          <div className="answer" key={row.answer}>
            <span className="ro">{row.label}</span>
            <p>{row.does}</p>
          </div>
        ))}
      </div>
      <div className="need-foot">
        <button type="button" className="linkish" onClick={() => onOpen(need.workItem)}>
          Open the work item
        </button>
        <span>Martin answers, signed in</span>
      </div>
    </article>
  );
}

function Kick({ need }: { need: Need }) {
  return (
    <div className="kick">
      <b>{need.kicker}</b>
      <span>
        #{need.workItem} · {stageName(need.stage)} · {need.waited}
      </span>
    </div>
  );
}

/** Martin's card: his answers, the words field when he opens it, and what the service said if it refused. */
function MartinsCard({ need, token, onOpen }: { need: Need; token: string; onOpen: (item: string) => void }) {
  const id = useId();
  const stepUp = useStepUp();
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [words, setWords] = useState('');
  const [refusal, setRefusal] = useState<string | undefined>(undefined);
  const field = useRef<HTMLTextAreaElement>(null);
  // The field takes focus as it opens, so he can write at once.
  useEffect(() => {
    if (writing) field.current?.focus();
  }, [writing]);

  const send = async (answer: Need['answers'][number]) => {
    if (busy) return;
    setBusy(true);
    setRefusal(undefined);
    let cancelled = false;
    const ask =
      answer.stepUp &&
      (async () => {
        cancelled = !(await stepUp.ask({
          title: `Approve #${need.workItem}`,
          what: answer.does,
          why: 'Approving overrides a guardrail',
        }));
        return !cancelled;
      });
    const body = { hold: need.hold, ...(answer.answer === 'answered' && { words: words.trim() }) };
    const got = await write(`/admin/holds/${need.workItem}/${ROUTE[answer.answer]}`, body, token, ask || undefined);
    setBusy(false);
    // Cancelled at the passkey: nothing was sent, and nothing to say.
    if (cancelled) return;
    if (got.status !== 200) return setRefusal(said(got));
    // Answered: the card moves to Answered today as the event arrives, unless words left it held.
    setWriting(false);
    setWords('');
  };

  return (
    <article className="need" aria-labelledby={id} aria-busy={busy || undefined}>
      <Kick need={need} />
      <h3 id={id}>{need.title}</h3>
      <Evidence need={need} />
      <div className="answers">
        {need.answers.map((row) => (
          <div className="answer" key={row.answer}>
            {row.answer === 'answered' ? (
              <button
                type="button"
                className="btn"
                aria-expanded={writing}
                aria-controls={`${id}-words`}
                aria-disabled={busy || undefined}
                onClick={() => !busy && setWriting(!writing)}
              >
                {row.label}
              </button>
            ) : (
              <button type="button" className="btn" aria-disabled={busy || undefined} onClick={() => void send(row)}>
                {row.label}
                {row.stepUp && !stepUp.fresh && <Key />}
              </button>
            )}
            <p>{row.does}</p>
            {row.answer === 'answered' && writing && (
              <form
                className="words-form"
                id={`${id}-words`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (words.trim()) void send(row);
                }}
              >
                <label className="sr" htmlFor={`${id}-text`}>
                  Your answer to #{need.workItem}
                </label>
                <textarea
                  ref={field}
                  id={`${id}-text`}
                  className="field"
                  maxLength={WORDS}
                  rows={3}
                  value={words}
                  placeholder="What the line should know"
                  onChange={(event) => setWords(event.currentTarget.value)}
                />
                <div className="row">
                  <span className="help">
                    {need.aboutReport
                      ? 'Your words stay yours: a visitor’s report opened this, so no visitor and no agent reads them.'
                      : 'Visitors see your words, with anything shaped like a secret left out.'}{' '}
                    <span className="chars">
                      {words.length} / {WORDS}
                    </span>
                  </span>
                  <button
                    type="submit"
                    className="btn primary small"
                    disabled={!words.trim()}
                    aria-disabled={busy || undefined}
                  >
                    Send
                  </button>
                </div>
              </form>
            )}
          </div>
        ))}
      </div>
      {refusal && (
        <p className="canary-refusal" role="alert">
          {refusal}
        </p>
      )}
      <div className="need-foot">
        <button type="button" className="linkish" onClick={() => onOpen(need.workItem)}>
          Open the work item
        </button>
      </div>
    </article>
  );
}

export function NeedsYou({ needs, admin, onOpen }: { needs: NeedsView; admin: Admin; onOpen: (item: string) => void }) {
  const martin = admin.kind === 'martin';
  const { holds, answered } = needs;
  return (
    <article className="panel needs" aria-labelledby="needs-title">
      <div className="panel-head">
        <h2 id="needs-title">{martin ? 'Needs you' : 'Waiting on Martin'}</h2>
        {holds.length > 0 && <span className="count-attn">{holds.length} waiting</span>}
      </div>
      {holds.length ? (
        <div className="needs-list">
          {holds.map((need) =>
            martin ? (
              <MartinsCard key={need.hold} need={need} token={admin.session.token} onOpen={onOpen} />
            ) : (
              <ReadOnlyCard key={need.hold} need={need} onOpen={onOpen} />
            ),
          )}
        </div>
      ) : (
        <p className="help">
          {martin ? 'Nothing waits on you.' : 'Nothing waits on Martin.'} A hold lands here when the line or triage
          needs a person: a spec to approve, a pull request a gate held, a fix waiting for {martin ? 'your' : 'his'}{' '}
          deploy.
        </p>
      )}
      {answered.length > 0 && (
        <div className="answered">
          <span className="label">Answered today</span>
          <ul>
            {answered.map((row) => (
              <li key={`${row.workItem}-${row.at}`}>
                <span className="mono">{clock(row.at)}</span>
                <span>
                  #{row.workItem} · {row.how}.
                  {row.words === 'kept' ? (
                    <> His words stay his: the hold was about a visitor’s report.</>
                  ) : (
                    row.words && (
                      <>
                        {' '}
                        <q className="said">{row.words}</q>
                      </>
                    )
                  )}
                  {row.did && <> {row.did}</>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}
