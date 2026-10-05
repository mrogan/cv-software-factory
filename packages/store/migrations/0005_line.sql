-- The line after triage: which work items are on it, at which stage, and which worker holds each. A work item's
-- progress is its events, and the line decides what to do next from them; this table is the queue that bounds the
-- work and leases it, as the inbox does for triage, and keeps the little the line needs that no event carries.

create table line (
  work_item  text primary key,
  -- Where it is: a stage with work to do or wait for, held for Martin, or ended (merged or closed).
  stage      text not null check (stage in ('plan', 'build', 'gates', 'review', 'held', 'ended')),
  taken_at   timestamptz not null default clock_timestamp(),
  moved_at   timestamptz not null default clock_timestamp(),
  -- The lease: the worker acting on it, and until when. Another may act once it has passed.
  held_by    text,
  held_until timestamptz,
  -- Every step started for the work item, so each attempt's job has a name of its own.
  steps      integer not null default 0 check (steps >= 0),
  -- Failed attempts at the step in hand, and why the last one failed. Cleared when the work item moves on.
  failures   integer not null default 0 check (failures >= 0),
  failure    text,
  -- The ticket's issue in the app's repository, opened when the work item entered Plan.
  issue      integer check (issue > 0),
  -- The coder's session, which a later round resumes.
  session    text
);

create index line_working on line (stage, taken_at) where stage <> 'ended';

-- Only the line writes here, and nothing is deleted: an ended work item stays, so it is never taken again.
grant select, insert, update on line to factory_writer;
