-- What milestone 5's runners need: a token for each job, which the gateway and the handback accept for that work item
-- and that agent only, until the job ends; and room in the audit log for an agent's calls.

-- A job's token, kept as its SHA-256 only: the token itself goes to the job's pod and nowhere else. A token is good
-- while its job has not ended; ending is the only change a row may have.
create table job_tokens (
  token_sha256 text primary key check (token_sha256 ~ '^[0-9a-f]{64}$'),
  -- The Kubernetes Job the token was made for.
  job          text not null unique,
  work_item    text not null,
  agent        text not null,
  issued_at    timestamptz not null default clock_timestamp(),
  ended_at     timestamptz
);

create function job_tokens_only_end() returns trigger language plpgsql as $$
begin
  if tg_op <> 'UPDATE' or old.ended_at is not null
     or (new.token_sha256, new.job, new.work_item, new.agent, new.issued_at)
        is distinct from (old.token_sha256, old.job, old.work_item, old.agent, old.issued_at) then
    raise exception 'a job token may only be ended, once';
  end if;
  return new;
end
$$;

create trigger job_tokens_only_end before update or delete on job_tokens
  for each row execute function job_tokens_only_end();
create trigger job_tokens_no_truncate before truncate on job_tokens
  for each statement execute function events_refuse_change();

grant select, insert, update (ended_at) on job_tokens to factory_writer;

-- An agent's calls: which job made each, and the prompt cache's share of its input, which is priced apart.
alter table model_calls
  add column job                text,
  add column cache_read_tokens  integer not null default 0 check (cache_read_tokens >= 0),
  add column cache_write_tokens integer not null default 0 check (cache_write_tokens >= 0);

create index model_calls_job on model_calls (job) where job is not null;
