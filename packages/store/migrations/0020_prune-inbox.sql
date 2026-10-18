-- Triage deletes the inbox's old repeats: a signal it counted, on a ticket that already had it, which nothing reads
-- again. Without this the inbox grows by thousands of rows a day while a defect stays unfixed. What it deletes, and
-- what it keeps, is `pruneInbox` in packages/store/src/inbox.ts.
--
-- The writer may delete a counted signal and no other: a signal that opened a ticket, is held or still waits is what
-- triage reads again, so the store refuses its delete whatever query asks. Row security does it, with a policy for
-- each thing the writer did before, unchanged, beside the delete's. The table's owner, as the migrations run, is not
-- held to the policies.
alter table inbox enable row level security;
create policy inbox_writer_reads on inbox for select to factory_writer using (true);
create policy inbox_writer_sends on inbox for insert to factory_writer with check (true);
create policy inbox_writer_triages on inbox for update to factory_writer using (true) with check (true);
create policy inbox_writer_prunes on inbox for delete to factory_writer using (outcome = 'counted');
grant delete on inbox to factory_writer;

-- The prune finds the old repeats by the first, and whether a sense has a newer signal by the second.
create index inbox_counted on inbox (received_at) where outcome = 'counted';
create index inbox_sense on inbox (sense, received_at);
