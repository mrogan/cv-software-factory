/**
 * What the console says when it has nothing ordinary to show: the connection lost or not yet made, events from a
 * newer factory, and samples standing in for real work. An empty store is shown where the reel would be.
 */
import { useRef } from 'react';
import { clock } from '../format.ts';
import type { View } from '../projection/index.ts';
import type { Source } from '../source.ts';

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

/** Where the reel would be, when the store holds no work at all. */
export function EmptyReel() {
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
