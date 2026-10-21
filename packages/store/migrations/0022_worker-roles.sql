-- A role for each worker that uses the store, granted only the tables and columns it uses, so a worker taken over
-- cannot touch another's tables: the senses cannot touch the line, the gateway cannot end a job's token, and only triage
-- says what became of a signal. Every worker may still append any event; row security on Martin's commands follows
-- (milestone 7, task 4). What each role may do is set out in one table, `policy/store-grants.ts`, and the grants test
-- fails unless the store's grants and row security are exactly that. The GitHub worker and the traffic generator never
-- connect to the store, and have no role.
--
-- `factory_writer` keeps its grants until every worker has moved to its own role (#435).
-- Passwords are set outside migrations, from the cluster's Secrets (`make worker-secrets`).

-- Roles belong to the whole server, not one database, so another database may have made them already, perhaps
-- differently: each is made, or set as it must be, and changed only if it is not, since two databases migrating at once
-- must not both write the same role.
do $$
declare
  role text;
begin
  -- Every worker appends events through this one role, so row security on events can name it once. It cannot log in.
  begin
    create role factory_worker nologin;
  exception when duplicate_object or unique_violation then null;
  end;
  if (select rolcanlogin from pg_roles where rolname = 'factory_worker') then
    alter role factory_worker nologin;
  end if;
  foreach role in array array['factory_triage', 'factory_line', 'factory_gateway', 'factory_probes', 'factory_crawler',
                               'factory_intake', 'factory_logs'] loop
    begin
      execute format('create role %I login', role);
    exception when duplicate_object or unique_violation then null;
    end;
    if not (select rolcanlogin and rolinherit from pg_roles where rolname = role) then
      execute format('alter role %I login inherit', role);
    end if;
    if not exists (
      select 1 from pg_auth_members
      where roleid = 'factory_worker'::regrole and member = role::regrole and inherit_option
    ) then
      execute format('grant factory_worker to %I with inherit true', role);
    end if;
  end loop;
end
$$;

grant usage on schema public to factory_worker;

-- Every worker: read and append events. The first real event records the store's kind (events_one_kind), which runs
-- as the role that appends.
grant select, insert on events to factory_worker;
grant select, insert on store to factory_worker;

-- Triage: takes each signal from the inbox, records what it made of it, deletes the repeats it counted, and numbers
-- the work items it opens.
grant select, update (attempts, not_before, failure, triaged_at, outcome, work_item), delete on inbox to factory_triage;
grant usage on sequence work_items to factory_triage;

-- The line: its queue, its runners' job tokens and logs, and a step's spend; the pictures and looks it attaches at
-- Verify; and the signals it leaves triage, from a canary's analysis and from the planner.
grant select, insert (work_item, stage),
  update (stage, moved_at, held_by, held_until, steps, failures, failure, effects, reopened, issue, session)
  on line to factory_line;
grant select, insert (token_sha256, job, work_item, agent, traceparent), update (ended_at) on job_tokens to factory_line;
grant select, insert (job, work_item, agent, part, pod, hash, size, ending, reason) on step_logs to factory_line;
grant select on model_calls, pictures, looks to factory_line;
grant insert (id, sense, fingerprint, signal) on inbox to factory_line;

-- The gateway: the ledger of model calls, and the job tokens it accepts.
grant select, insert on model_calls to factory_gateway;
grant select on job_tokens to factory_gateway;

-- The probes: their signals, the pictures of each release and the looks they box on them. Forgetting pictures reads
-- which hashes a waiting signal names.
grant select, insert (canary, stable, path, route, before, after, changed, diff), update (rollout), delete
  on pictures to factory_probes;
grant select, insert, update (path, elements, seen_at) on looks to factory_probes;
grant select (signal, triaged_at), insert (id, sense, fingerprint, signal) on inbox to factory_probes;

-- The crawler: its signals, and the looks it boxes. Keeping one in place of the last for the same check
-- (`on conflict ... do update`) reads the row it replaces.
grant select, insert, update (path, elements, seen_at) on looks to factory_crawler;
grant insert (id, sense, fingerprint, signal) on inbox to factory_crawler;

-- The intake: the metrics' signals.
grant insert (id, sense, fingerprint, signal) on inbox to factory_intake;

-- The log watcher: its signals and the visitors' reports, and where it left off, from the newest it sent.
grant select (sense, signal), insert (id, sense, fingerprint, signal) on inbox to factory_logs;

-- Row security on the inbox (0020) holds each role to its own rows: a sense sends only its own signals, and only triage
-- changes one or deletes a repeat it counted. Visitors' reports and the planner's findings are in the inbox in their own
-- words, so the probes read only the senses' signals triage has still to take, and the log watcher only its own.
create policy inbox_triage_reads on inbox for select to factory_triage using (true);
create policy inbox_probes_read on inbox for select to factory_probes
  using (triaged_at is null and sense not in ('report', 'planner'));
create policy inbox_logs_read on inbox for select to factory_logs using (sense in ('logs', 'report'));
create policy inbox_triage_triages on inbox for update to factory_triage using (true) with check (true);
create policy inbox_triage_prunes on inbox for delete to factory_triage using (outcome = 'counted');
create policy inbox_line_sends on inbox for insert to factory_line with check (sense in ('canary', 'planner'));
create policy inbox_probes_send on inbox for insert to factory_probes with check (sense = 'probe');
create policy inbox_crawler_sends on inbox for insert to factory_crawler with check (sense = 'crawler');
create policy inbox_intake_sends on inbox for insert to factory_intake with check (sense = 'metrics');
create policy inbox_logs_send on inbox for insert to factory_logs with check (sense in ('logs', 'report'));

-- Row security on the looks: each sense keeps only its own, and the probes, which box them all on their pictures, and
-- the line read them all; the crawler reads only its own. The writer goes on as before.
alter table looks enable row level security;
create policy looks_writer on looks for all to factory_writer using (true) with check (true);
create policy looks_read on looks for select to factory_probes, factory_line using (true);
create policy looks_crawler_reads on looks for select to factory_crawler using (sense = 'crawler');
create policy looks_probes_keep on looks for insert to factory_probes with check (sense = 'probe');
create policy looks_probes_move on looks for update to factory_probes using (sense = 'probe') with check (sense = 'probe');
create policy looks_crawler_keeps on looks for insert to factory_crawler with check (sense = 'crawler');
create policy looks_crawler_moves on looks for update to factory_crawler
  using (sense = 'crawler') with check (sense = 'crawler');
