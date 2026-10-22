-- Martin giving his passkey again in a session is recorded, as his signing in is: one of his commands, so only his
-- roles may append it, and the console shows only those his roles appended.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked')
$$;
