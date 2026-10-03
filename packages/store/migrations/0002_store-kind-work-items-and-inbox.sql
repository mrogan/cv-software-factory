-- What milestone 4 needs before the first real event: the store's kind recorded once, the numbers work items take,
-- and the inbox where the senses leave signals for triage.

-- Whether the store holds samples or real events, decided by its first event (or by `make real-store`) and never
-- changed. An append reads one row here instead of scanning every event.
create table store (
  one       boolean primary key default true check (one),
  sample    boolean not null,
  chosen_at timestamptz not null default clock_timestamp()
);

insert into store (sample) select sample from events order by seq limit 1;

create trigger store_never_changes before update or delete on store
  for each row execute function events_refuse_change();
create trigger store_no_truncate before truncate on store
  for each statement execute function events_refuse_change();

-- Appends already run one at a time (events_one_at_a_time), so the first one decides alone.
create or replace function events_one_kind() returns trigger language plpgsql as $$
declare
  held boolean;
begin
  select sample into held from store;
  if not found then
    insert into store (sample) values (new.sample);
  elsif held <> new.sample then
    raise exception 'this store holds % events, so it refuses %',
      case when held then 'sample' else 'real' end,
      case when held then 'real ones' else 'samples' end;
  end if;
  return new;
end
$$;

grant select, insert on store to factory_writer;
grant select on store to console_reader;

-- Work items are numbered by the store. Samples bring their own numbers, below these.
create sequence work_items as integer start with 1000 minvalue 1000;
grant usage on sequence work_items to factory_writer;

-- The inbox: what the senses found, waiting for triage (the first part of the orchestrator's queue). A sense
-- inserts a signal; triage takes each once, with `for update skip locked`, and records what it made of it. A check
-- that passes writes nothing here.
create table inbox (
  id          uuid primary key,
  received_at timestamptz not null default clock_timestamp(),
  sense       text not null check (sense in ('probe', 'crawler', 'metrics', 'logs', 'report')),
  -- The route and symptom class a sense found, such as `/search server-error`. A report has none: Jev judges it.
  fingerprint text check ((fingerprint is null) = (sense = 'report')),
  -- The signal as the sense sent it. A report's text is in here, so the console's role cannot read this table.
  signal      jsonb not null,
  -- Taking it: how often triage has tried, when it may next, and why the last try failed.
  attempts    integer not null default 0,
  not_before  timestamptz not null default clock_timestamp(),
  failure     text,
  -- What triage made of it, once it has.
  triaged_at  timestamptz,
  outcome     text check (outcome in ('opened', 'evidence', 'counted', 'report')),
  work_item   text,
  check ((triaged_at is null) = (outcome is null))
);

create index inbox_waiting on inbox (not_before) where triaged_at is null;
create index inbox_fingerprint on inbox (fingerprint, received_at) where fingerprint is not null;

create function inbox_notify() returns trigger language plpgsql as $$
begin
  perform pg_notify('inbox', new.id::text);
  return null;
end
$$;

create trigger inbox_received after insert on inbox
  for each row execute function inbox_notify();

-- Senses insert and triage updates what it made of a signal. Nothing is deleted: the inbox counts repeats.
grant select, insert on inbox to factory_writer;
grant update (attempts, not_before, failure, triaged_at, outcome, work_item) on inbox to factory_writer;
