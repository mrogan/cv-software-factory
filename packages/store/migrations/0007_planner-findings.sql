-- The planner leaves triage what it noticed outside its ticket, as a signal of its own. Like a report, it has no
-- fingerprint: triage judges its words, which stay in the inbox and the private payload, never in a public view.
-- 0002 left these checks unnamed, so Postgres named them: by their column, or `inbox_check` for the one on two.
alter table inbox drop constraint inbox_sense_check;
alter table inbox add constraint inbox_sense_check
  check (sense in ('probe', 'crawler', 'metrics', 'logs', 'report', 'planner'));

alter table inbox drop constraint inbox_check;
alter table inbox add constraint inbox_fingerprint_check
  check ((fingerprint is null) = (sense in ('report', 'planner')));

-- Triage looks for the defects the planner noticed that are still held after every event, so their holds have an
-- index of their own.
create index events_finding_holds on events (seq) where type = 'hold.started' and payload->>'cause' = 'finding';

alter table inbox drop constraint inbox_outcome_check;
alter table inbox add constraint inbox_outcome_check
  check (outcome in ('opened', 'evidence', 'counted', 'report', 'finding'));
