-- The admin service (milestone 7, task 4): Martin signing in and out, and his passkeys enrolled and revoked, are events
-- like his commands, so only his roles may append them, and the console shows only those his roles appended.
--
-- Numbered 0025: 0024 is taken by the writer's grants taken away (#435), which merges on its own.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'passkey.enrolled', 'passkey.revoked')
$$;

-- `factory admin enrol --revoke-others` records each passkey it revokes, and appends nothing else. It reads back only
-- what it appended, as an append that may be retried does, and the store's kind, which every append checks.
grant select, insert on events to factory_enrol;
grant select, insert on store to factory_enrol;
create policy events_enrol_reads on events for select to factory_enrol using (type = 'passkey.revoked');
create policy events_enrol_revocations on events for insert to factory_enrol with check (type = 'passkey.revoked');

-- The console shows the admin events Martin's roles appended, the enrolment's revocations among them.
alter policy events_console_reads on events
  using (not admin_event(type) or appended_by is null
         or appended_by in ('factory_admin', 'factory_operator', 'factory_enrol'));
