-- Whether alerts reach Martin's phone, switched from the console's Controls, is recorded as `alerts.switched`: one of
-- his commands, so only his roles may append it, and the admin service, which tells Prometheus, reads only those his
-- roles appended. Switching them off keeps every alert from his phone, so no worker may do it in his name.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed', 'controls.changed', 'alerts.switched', 'flag.staged',
                  'improvement.requested')
$$;
