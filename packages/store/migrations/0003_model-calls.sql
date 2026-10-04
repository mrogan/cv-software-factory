-- The audit log of every call to a model provider, answered or not, and the ledger that spend is counted from
-- (spec section 6, guardrail 7). Written by the gateway, never by anything else, and never changed.

create table model_calls (
  id            uuid primary key,
  at            timestamptz not null default clock_timestamp(),
  agent         text not null,
  -- The work item the call was for, if any.
  work_item     text,
  provider      text not null,
  model         text not null,
  -- The question set, such as `triage/v1`.
  question_set  text not null,
  input_tokens  integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  -- What the call cost, in US dollars. A replay costs nothing, and so does a call that was refused or failed.
  cost_usd      numeric(14, 8) not null default 0 check (cost_usd >= 0),
  duration_ms   integer not null check (duration_ms >= 0),
  -- The SHA-256 of the request, which names its cassette.
  cassette      text check (cassette ~ '^[0-9a-f]{64}$'),
  outcome       text not null check (outcome in ('answered', 'replayed', 'refused', 'failed'))
);

create index model_calls_at on model_calls (at);
create index model_calls_work_item on model_calls (work_item, at) where work_item is not null;

create trigger model_calls_append_only before update or delete on model_calls
  for each row execute function events_refuse_change();
create trigger model_calls_no_truncate before truncate on model_calls
  for each statement execute function events_refuse_change();

-- The gateway runs as the factory's writer. The console's reader gets nothing: spend is not public.
grant select, insert on model_calls to factory_writer;
