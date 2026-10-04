/**
 * What the console says when it has nothing ordinary to show: the connection lost or not yet made, events from a
 * newer factory, and samples standing in for real work. An empty store is shown where the reel would be.
 */
import { useRef } from 'react';
import { clock, dayLabel, money } from '../format.ts';
import type { CapSpell, ProviderSpell, View } from '../projection/index.ts';
import type { Source, StoreKind } from '../source.ts';

export function States({ source, view }: { source: Source; view: View }) {
  const { connection, newer } = source;
  // When the connection dropped, so the notice can say what the page shows is as of then.
  const dropped = useRef<number | undefined>(undefined);
  if (connection === 'reconnecting') dropped.current ??= Date.now();
  else dropped.current = undefined;
  return (
    <>
      {connection === 'reconnecting' && (
        <p className="notice" role="status">
          <span className="label">Reconnecting</span>
          The connection to the factory dropped at {clock(dropped.current ?? Date.now())}. The console is trying again,
          and will catch up on anything it missed when it is back.
        </p>
      )}
      {connection === 'failed' && (
        <p className="notice" role="status">
          <span className="label">Unreachable</span>
          The console can’t reach the factory just now. It tries again every few seconds, and the line will appear when
          the factory answers.
        </p>
      )}
      {newer.length > 0 && (
        <p className="notice" role="status">
          <span className="label">Newer events</span>
          {newer.length === 1 ? 'One event was' : `${newer.length} events were`} written by a newer version of the
          factory than this page understands, so they are left out.{' '}
          {connection === 'recorded'
            ? 'Everything else in the recording is here.'
            : 'Reloading the page fetches the newer console.'}
        </p>
      )}
      {view.header.capped && <SpendCap spell={view.header.capped} />}
      {view.header.waiting && <ProviderWait spell={view.header.waiting} />}
      {view.sample && (
        <p className="notice">
          <span className="label">Samples</span>
          Every work item below was written by hand to show how the console works. The screenshots are of the real shop,
          with each sample’s change made in a copy that went nowhere. The factory’s own work replaces them.
        </p>
      )}
    </>
  );
}

/** When the gateway refuses model calls until a cap resets: in UTC, as the caps are kept, and where the viewer is. */
function resetsAt(spell: CapSpell): string {
  const reset = new Date(spell.resets);
  const midnight = reset.getUTCHours() === 0 && reset.getUTCMinutes() === 0;
  if (spell.cap === 'day' && midnight) return `until midnight UTC (${clock(spell.resets)} here)`;
  return `until ${dayLabel(spell.resets)}, ${clock(spell.resets)}`;
}

/**
 * A spend cap reached: how much, until when, and that nothing is lost. A guardrail is shown, not hidden; and the
 * senses' tickets still open, because they call no model.
 */
function SpendCap({ spell }: { spell: CapSpell }) {
  const period = spell.cap === 'day' ? 'today’s' : 'this month’s';
  return (
    <p className="notice">
      <span className="label attn">Spend cap</span>
      <span>
        The factory has spent {money(spell.spentUsd)} of {period} {money(spell.limitUsd)} on models, so the gateway
        refuses every model call {resetsAt(spell)}. Reports wait in the inbox and none is lost. The senses keep
        watching, and their tickets still open, because they call no model.
      </span>
    </p>
  );
}

const PROVIDER_NAME = { anthropic: 'Anthropic', bedrock: 'Amazon Bedrock', local: 'The local model' };

/** Why a provider refuses, in a sentence. */
const BECAUSE = {
  credit: 'the account’s credit is spent',
  'workspace-limit': 'the workspace has reached its monthly spend limit',
  unreachable: 'it is not answering',
};

/**
 * A provider refusing for a cap the factory does not own: who, why, in its own words, and that the agents wait and
 * carry on by themselves when it answers again.
 */
function ProviderWait({ spell }: { spell: ProviderSpell }) {
  return (
    <p className="notice">
      <span className="label attn">Agents waiting</span>
      <span>
        {PROVIDER_NAME[spell.provider]} refuses model calls because {BECAUSE[spell.reason]} (“{spell.message}”), since{' '}
        {clock(spell.reached)}. The agents’ calls wait, and the gateway asks again every few minutes; work carries on by
        itself once it answers. Triage and the senses are not affected.
      </span>
    </p>
  );
}

/**
 * Where the reel would be, when the store holds no work at all. A store for real events says the senses are
 * watching and when to expect the first card; any other sends someone running it themselves to the samples.
 */
export function EmptyReel({ store }: { store: StoreKind | undefined }) {
  if (store === 'real') {
    return (
      <section className="history" aria-labelledby="history-title">
        <div className="history-head">
          <div>
            <h2 id="history-title">The shop, change by change</h2>
          </div>
        </div>
        <div className="empty-reel">
          <span className="label">Watching, nothing yet</span>
          <p>
            This store holds the factory’s own work, and nothing has needed a ticket yet. The probes and the crawler
            check the shop every few minutes, and the moment the app changes. A check that fails twice in a row becomes
            a signal, and triage turns it into a card here.
          </p>
          <p>
            A check that passes writes nothing, so an empty reel means the senses have found nothing wrong yet. The
            first tickets usually appear within fifteen minutes.
          </p>
          <p className="help">
            Running it yourself? This is a store for real events, so <code>make samples</code> won’t load into it.{' '}
            <code>make status</code> shows the senses running.
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="history" aria-labelledby="history-title">
      <div className="history-head">
        <div>
          <h2 id="history-title">The shop, change by change</h2>
        </div>
      </div>
      <div className="empty-reel">
        <span className="label">Nothing yet</span>
        <p>
          The factory has not recorded any work. When it does, each work item appears here as a card: what was wrong or
          wanted, what changed on the site, and what it cost.
        </p>
        <p className="help">
          Running it yourself? <code>make samples</code> loads twelve sample work items.
        </p>
      </div>
    </section>
  );
}
