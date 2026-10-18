-- Triage deletes the inbox's old repeats: a signal it counted, on a ticket that already had it, which nothing reads
-- again. Without this the inbox grows by thousands of rows a day while a defect stays unfixed. What it deletes, and
-- what it keeps, is `pruneInbox` in packages/store/src/inbox.ts.
grant delete on inbox to factory_writer;
