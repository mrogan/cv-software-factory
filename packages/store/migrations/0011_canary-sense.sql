-- A rollback is a signal: the line leaves triage one from the canary's analysis for each measure that failed a
-- release. The canary is a sense like the others, with a fingerprint (its route and symptom class).
alter table inbox drop constraint inbox_sense_check;
alter table inbox add constraint inbox_sense_check
  check (sense in ('probe', 'crawler', 'metrics', 'logs', 'canary', 'report', 'planner'));
