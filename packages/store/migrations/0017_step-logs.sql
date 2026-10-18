-- What a runner's pods printed, kept with the step: the line reads each pod's log before it deletes the step's Jobs,
-- however the step ended, and keeps it in the artifact store. This is their index. Rows are only added: a log kept is
-- the record of that step, and nothing changes it.
create table step_logs (
  -- The step's job, as its token names it (job_tokens), and its pod: one of the job's two, or more if Kubernetes made
  -- another.
  job       text not null,
  work_item text not null,
  agent     text not null,
  part      text not null check (part in ('prepare', 'agent')),
  pod       text not null,
  -- The log in the artifact store, as plain text.
  hash      text not null check (hash ~ '^[0-9a-f]{64}$'),
  size      integer not null check (size >= 0),
  -- How the step ended, as the line saw it, and why when it failed: `errored` is the line failing to run it.
  ending    text not null check (ending in ('handed-back', 'failed', 'stopped', 'errored')),
  reason    text,
  kept_at   timestamptz not null default clock_timestamp(),
  primary key (job, pod)
);

create index step_logs_work_item on step_logs (work_item, kept_at);

grant select, insert on step_logs to factory_writer;
