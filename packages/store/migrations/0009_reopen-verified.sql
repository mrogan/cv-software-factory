-- One fingerprint, one ticket: a sense's signal on a ticket closed as verified reopens it, since the same defect came
-- back, and the inbox records that as what triage made of the signal.
alter table inbox drop constraint inbox_outcome_check;
alter table inbox add constraint inbox_outcome_check
  check (outcome in ('opened', 'evidence', 'counted', 'report', 'finding', 'reopened'));
