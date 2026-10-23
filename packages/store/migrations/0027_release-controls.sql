-- Martin's controls of a canary from the console (promote, pause, resume, abort, retry) are recorded as
-- `release.controlled`: one of his commands, so only his roles may append it, and the line takes his abort from it only
-- when one of them did.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled')
$$;
