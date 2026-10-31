-- The line's record of what a release did is the line's alone: a step's analysis, a look of the background analysis,
-- and how the release ended (promoted, rolled back, aborted or in error). The rollback proof, the line's count of what
-- pages Martin and the console's Canary panel trust them, so no other worker may append one, in the line's name or its
-- own: a worker that untrusted input had turned could otherwise record a rollback that never happened, or a promotion
-- that hid one. `LINE_ONLY_TYPES` in the events package, which the store's tests hold this to; each reader also reads
-- only those `factory_line` appended, so this policy is not the only lock.
--
-- Every worker's insert policy (`events_not_his`) is rewritten, rather than one added beside it: Postgres ORs
-- permissive policies, so a second would let through what the first does. Martin's command line appends them only as
-- samples (`make samples`), never as real work. The admin service, the enrolment and the scoreboard append none already.

create function line_only_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('canary.stepped', 'canary.measuring', 'release.promoted', 'release.rolled-back', 'release.aborted',
                  'release.errored')
$$;

alter policy events_not_his on events
  with check (not admin_event(type) and not opens_improvement(type, payload)
              and (not line_only_event(type) or current_user = 'factory_line'));
alter policy events_operator_appends on events with check (not line_only_event(type) or sample);
