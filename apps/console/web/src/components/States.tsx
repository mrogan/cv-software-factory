/**
 * What the console says when it has nothing ordinary to show: the events still on their way, the connection lost,
 * an empty store, events from a newer factory, and samples standing in for real work.
 */
import type { View } from '../projection/index.ts';
import type { Source } from '../source.ts';

export function States({ source, view }: { source: Source; view: View }) {
  const { connection, newer, events } = source;
  return (
    <>
      {connection === 'loading' && (
        <p className="notice" role="status">
          <span className="label">Loading</span>
          Reading the factory’s events.
        </p>
      )}
      {connection === 'reconnecting' && (
        <p className="notice attn" role="status">
          <span className="label">Reconnecting</span>
          The connection to the factory dropped. The console is trying again, and will catch up on anything it missed.
          What you see is as of the moment it dropped.
        </p>
      )}
      {connection === 'failed' && (
        <p className="notice attn" role="alert">
          <span className="label">Unavailable</span>
          The console could not read the factory’s events. Reload the page to try again.
        </p>
      )}
      {(connection === 'live' || connection === 'recorded') && events.length === 0 && (
        <p className="notice" role="status">
          <span className="label">Nothing yet</span>
          The factory has not recorded any work. When it does, the line comes to life and each work item appears here.
        </p>
      )}
      {newer.length > 0 && (
        <p className="notice" role="status">
          <span className="label">Newer events</span>
          {newer.length === 1 ? 'One event was' : `${newer.length} events were`} written by a newer version of the
          factory than this console understands, so they are left out. Reloading the page fetches the newer console.
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
