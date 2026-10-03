-- The event store: every step of every work item, appended once and never changed (spec 5.1, ADR 0002).

create table events (
  seq         bigint generated always as identity primary key,
  id          uuid not null unique,
  ts          timestamptz not null,
  work_item   text,
  type        text not null,
  version     integer not null check (version > 0),
  actor       text not null,
  summary     text not null,
  payload     jsonb not null,
  artifacts   jsonb not null,
  -- What anyone but Martin may see: the summary, payload and artifacts with report text, keys and secrets left out.
  public      jsonb not null,
  -- A store holds samples or real events, never both.
  sample      boolean not null,
  appended_at timestamptz not null default clock_timestamp()
);

create index events_work_item on events (work_item, seq);

-- Append-only, whatever the role: no stored event is updated, deleted or truncated. Older versions are upcast
-- when they are read instead.
create function events_refuse_change() returns trigger language plpgsql as $$
begin
  raise exception 'events are append-only, so % is refused', lower(tg_op)
    using hint = 'Append a new event instead; reading upcasts older versions.';
end
$$;

create trigger events_append_only before update or delete on events
  for each row execute function events_refuse_change();
create trigger events_no_truncate before truncate on events
  for each statement execute function events_refuse_change();

-- One append at a time, taken before any row gets its seq, so events commit in seq order. A reader that has seen
-- seq n has then seen everything before it, which is what lets a client resume from the last seq it had.
create function events_one_at_a_time() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('events'));
  return null;
end
$$;

create trigger events_serial before insert on events
  for each statement execute function events_one_at_a_time();

create function events_one_kind() returns trigger language plpgsql as $$
begin
  if exists (select 1 from events where sample <> new.sample) then
    raise exception 'this store holds % events, so it refuses %',
      case when new.sample then 'real' else 'sample' end,
      case when new.sample then 'samples' else 'real ones' end;
  end if;
  return new;
end
$$;

create trigger events_never_mixed before insert on events
  for each row execute function events_one_kind();

-- Listeners hear the new seq when the transaction commits, and not at all if it rolls back.
create function events_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('events', new.seq::text);
  return null;
end
$$;

create trigger events_appended after insert on events
  for each row execute function events_notify();

-- Two roles, each with only what it needs. Their passwords are set outside migrations, from the cluster's Secrets.
do $$
begin
  if not exists (select from pg_roles where rolname = 'factory_writer') then create role factory_writer login; end if;
  if not exists (select from pg_roles where rolname = 'console_reader') then create role console_reader login; end if;
end
$$;

grant usage on schema public to factory_writer, console_reader;

-- The factory's workers append and read.
grant select, insert on events to factory_writer;

-- The console reads public views and nothing else: not the payload, the summary or the artifacts behind them.
grant select (seq, id, ts, work_item, type, version, actor, public, appended_at) on events to console_reader;
