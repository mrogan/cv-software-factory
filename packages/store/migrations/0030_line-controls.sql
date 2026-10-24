-- Martin's controls of the line from the console (the autonomy level, whether agents take new work, auto-merge, and
-- what the line takes) are recorded as `controls.changed`: one of his commands, so only his roles may append it, and
-- the line and the admin service read only those his roles appended.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed', 'controls.changed')
$$;
