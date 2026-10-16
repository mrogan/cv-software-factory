-- More new problems than a handful from one sense at once are held for Martin as one burst, with no ticket: the inbox
-- records each signal the burst holds as `held`, on the burst's work item. Triage looks for the bursts still held with
-- each signal that would open a ticket, so their holds have an index of their own.
alter table inbox drop constraint inbox_outcome_check;
alter table inbox add constraint inbox_outcome_check
  check (outcome in ('opened', 'evidence', 'counted', 'report', 'finding', 'reopened', 'held'));

create index events_burst_holds on events (seq) where type = 'hold.started' and payload->>'cause' = 'burst';
