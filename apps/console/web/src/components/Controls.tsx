/**
 * The bottom row, for everyone: Controls, holding for now its Spend group. Needs you joins it on the left, and the
 * line's own controls join Spend (milestone 7, tasks 6 and 8).
 *
 * Spend is three meters in ink, since spend is no fault: the models today against the day's cap, this month against
 * the month's, and the dearest work item today against a work item's cap, with when the day resets, in UTC. A meter at
 * its cap turns `attn`. A visitor sees the same, read only, with who changes the caps.
 */
import { money } from '../format.ts';
import type { Meter, SpendView } from '../projection/index.ts';

function SpendMeter({ label, meter, note }: { label: string; meter: Meter; note?: string }) {
  const share = meter.capUsd ? Math.min(100, (meter.spentUsd / meter.capUsd) * 100) : 0;
  return (
    <div className="meter">
      <div className="meter-figures">
        <span>
          {label}
          {note && <span className="muted"> {note}</span>}
        </span>
        <span className="mono">
          {money(meter.spentUsd)}{' '}
          <span className="muted">{meter.capUsd === null ? 'no cap' : `of ${money(meter.capUsd)}`}</span>
          {meter.atCap && <span className="sr">, at the cap</span>}
        </span>
      </div>
      {meter.capUsd !== null && (
        // The figures say it in words; the bar draws them.
        <span className="bar ink" aria-hidden="true">
          <i className={meter.atCap ? 'attn' : undefined} style={{ width: `${share}%` }} />
        </span>
      )}
    </div>
  );
}

/** The Spend group: the three meters, as Controls and the settings page draw them. */
export function SpendGroup({ spend }: { spend: SpendView }) {
  return (
    <div className="ctl-group">
      <span className="label">
        <span>Spend</span>
        <span>resets at 00:00 UTC</span>
      </span>
      <SpendMeter label="Models today" meter={spend.today} />
      <SpendMeter label="This month" meter={spend.month} />
      {spend.dearest ? (
        <SpendMeter label="Dearest work item today" note={`#${spend.dearest.workItem}`} meter={spend.dearest} />
      ) : (
        <p className="help">No work item has spent anything on models today.</p>
      )}
    </div>
  );
}

export function Controls({ spend, martin }: { spend: SpendView; martin: boolean }) {
  return (
    <section className="bottom" aria-label="Needs you and controls">
      <article className="panel" aria-labelledby="controls-title">
        <div className="panel-head">
          <h2 id="controls-title">Controls</h2>
          {!martin && <span className="label">Read only</span>}
        </div>
        <SpendGroup spend={spend} />
        <p className="help">
          {martin
            ? 'Each cap is yours to set within its ceiling in the settings. Raising one asks for your passkey again.'
            : 'Only Martin changes these, signed in with his passkey, and every change is an event for all to see.'}
        </p>
        <div className="links">
          <a href="?view=settings">{martin ? 'Settings' : 'Models and spend caps'}</a>
        </div>
      </article>
    </section>
  );
}
