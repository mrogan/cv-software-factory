-- The trace of the step a job token was made for, as a W3C `traceparent`: the gateway starts each of the job's model
-- calls as a child of the step's span, so a work item's trace runs from the line through its runner's calls. Null for
-- a token made with no span in hand (the bench, or a line with no telemetry). Nullable and read by nothing before this
-- version, so code from before it goes on working beside it.
alter table job_tokens
  add column traceparent text check (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');

-- Still only ended, once: the trace is set as the token is made, like the rest.
create or replace function job_tokens_only_end() returns trigger language plpgsql as $$
begin
  if tg_op <> 'UPDATE' or old.ended_at is not null
     or (new.token_sha256, new.job, new.work_item, new.agent, new.issued_at, new.traceparent)
        is distinct from (old.token_sha256, old.job, old.work_item, old.agent, old.issued_at, old.traceparent) then
    raise exception 'a job token may only be ended, once';
  end if;
  return new;
end
$$;
