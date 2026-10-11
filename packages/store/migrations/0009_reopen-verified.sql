-- One fingerprint, one ticket: a sense's signal on a ticket closed as verified reopens it, since the same defect came
-- back, and the inbox records that as what triage made of the signal.
alter table inbox drop constraint inbox_outcome_check;
alter table inbox add constraint inbox_outcome_check
  check (outcome in ('opened', 'evidence', 'counted', 'report', 'finding', 'reopened'));

-- The line takes a reopened work item back into Plan once, wherever its row was when it reopened: this is the last
-- reopening it took back, by the event's seq.
alter table line add column reopened bigint;
