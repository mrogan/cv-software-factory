-- Martin's settings from the console (each agent's model and effort, and the spend caps, within policy) are recorded
-- as `settings.changed`: one of his commands, so only his roles may append it, and the gateway and the line read only
-- those his roles appended.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed')
$$;
