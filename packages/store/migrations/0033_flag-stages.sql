-- Martin's stages of the feature flags, set from the console's Controls, are recorded as `flag.staged`: one of his
-- commands, so only his roles may append it, and no worker can stage a flag in his name or pass a stage off as his.
-- Verify's comparison of a flag's two sides at the share stage (`flag.compared`) is the line's, as any worker's event.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed', 'controls.changed', 'flag.staged')
$$;
