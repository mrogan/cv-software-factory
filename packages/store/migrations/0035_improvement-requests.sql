-- Martin's requests for an improvement, from the console's "+", are recorded as `improvement.requested`: one of his
-- commands, so only his roles may append it. The admin service appends it with the work item of kind `improvement` it
-- opens, in one transaction, so it numbers work items as triage does. An improvement widens what the line does, so
-- only Martin's roles may open one at all: no worker can open an improvement, in his name or its own, and the line acts
-- on one only when its opening and its request came from his roles. Every other kind of work item is still opened by
-- the workers, and never by the admin service.

create or replace function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped',
                  'admin.signed-in', 'admin.signed-out', 'admin.stepped-up', 'passkey.enrolled', 'passkey.revoked',
                  'release.controlled', 'settings.changed', 'controls.changed', 'flag.staged', 'improvement.requested')
$$;

-- The opening of an improvement: Martin's, though `work-item.opened` is no command of his alone.
create function opens_improvement(type text, payload jsonb) returns boolean
  language sql immutable parallel safe as $$
  select type = 'work-item.opened' and payload->>'kind' = 'improvement'
$$;

alter policy events_not_his on events with check (not admin_event(type) and not opens_improvement(type, payload));
alter policy events_admin_commands on events with check (admin_event(type) or opens_improvement(type, payload));

grant usage on sequence work_items to factory_admin;
