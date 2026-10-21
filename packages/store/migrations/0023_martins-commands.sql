-- Martin's commands (milestone 7, task 4). Every worker may append events, and some handle what the internet sends, so
-- an event that says `actor: martin` proves nothing. From here:
--
-- - the store records the role that appended each event, set by the database and never by the client;
-- - row security on `events` lets only Martin's roles append his commands, the admin event types, and every other role
--   append anything else;
-- - the admin service and `factory admin enrol` have roles of their own, and Martin's command line one more, and only
--   the first two may touch the tables of signing in: the passkeys, the enrolment codes, the sessions and the WebAuthn
--   challenges, which hold hashes of the codes and the session ids, never the values.
--
-- What each role may do is set out in `policy/store-grants.ts`, and the grants test fails unless the store is exactly
-- that. Passwords are set outside migrations: the operator's by the make targets that use it, as the owner, from a
-- Secret no pod reads (`packages/store/src/operator.ts`); the admin service's and the enrolment's when they come.

-- Roles belong to the whole server, not one database: each is made, or set as it must be, as in 0022.
do $$
declare
  role text;
begin
  foreach role in array array['factory_admin', 'factory_operator', 'factory_enrol'] loop
    begin
      execute format('create role %I login', role);
    exception when duplicate_object or unique_violation then null;
    end;
    if not (select rolcanlogin and rolinherit from pg_roles where rolname = role) then
      execute format('alter role %I login inherit', role);
    end if;
  end loop;
end
$$;

grant usage on schema public to factory_admin, factory_operator, factory_enrol;

-- Martin's commands, as the store knows them: `ADMIN_TYPES` in the events package, which the store's tests hold this to.
-- A command the admin service adds joins both, the store's in a migration that replaces this function.
create function admin_event(type text) returns boolean language sql immutable parallel safe as $$
  select type in ('hold.answered', 'line.started', 'line.stopped')
$$;

-- The role that appended each event, as the database knows it (`current_user`, which is the appending role's own, not a
-- role it shares). An event stored before this has none: the factory took those as they were, and still does.
alter table events add column appended_by text;
alter table events alter column appended_by set default current_user;
alter table events add constraint events_appended_by check (appended_by is not null) not valid;

-- The default gives it; an append that names any other role, or none, is refused.
create function events_stamp_role() returns trigger language plpgsql as $$
begin
  if new.appended_by is distinct from current_user::text then
    raise exception 'the store records the role that appends an event, so it refuses one that names %',
      coalesce(new.appended_by, 'none');
  end if;
  return new;
end
$$;

create trigger events_stamped before insert on events
  for each row execute function events_stamp_role();

-- Row security on events. Every role that reads them reads every row, but the console's server, which reads only
-- their public views' columns, and only Martin's commands that the factory heeds: what it shows is what the factory
-- does, even were this guard to fail. Only Martin's roles append his commands: the admin service nothing else, and his command line anything, the
-- samples among them. The scoreboard appends its figures alone, as its trigger already holds it to (0012).
alter table events enable row level security;
create policy events_read on events for select
  to factory_worker, factory_writer, scoreboard_writer, factory_admin, factory_operator using (true);
create policy events_console_reads on events for select to console_reader
  using (not admin_event(type) or appended_by is null or appended_by in ('factory_admin', 'factory_operator'));
create policy events_not_his on events for insert to factory_worker, factory_writer
  with check (not admin_event(type));
create policy events_scores on events for insert to scoreboard_writer with check (type = 'score.updated');
create policy events_admin_commands on events for insert to factory_admin with check (admin_event(type));
create policy events_operator_appends on events for insert to factory_operator with check (true);

grant select, insert on events to factory_admin, factory_operator;
grant select, insert on store to factory_admin, factory_operator;

-- Signing in. One-time codes from `factory admin enrol`, kept as their SHA-256: ten minutes, five tries across every
-- client, and used once (`policy/access.ts`, ENROLMENT_CODE). The enrolment adds a code and nothing more; its lifetime is
-- the store's to set.
create table enrolment_codes (
  code_sha256 text primary key check (code_sha256 ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '10 minutes',
  tries       integer not null default 0 check (tries between 0 and 5),
  used_at     timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '10 minutes'),
  check (used_at is null or used_at < expires_at)
);

-- Martin's passkeys, each enrolled with a code of its own: the credential's id and public key, never anything secret.
-- At most two are held at once (PASSKEYS), and a revoked one stays revoked.
create table passkeys (
  -- The credential's id, base64url, as the authenticator gave it: at most 1023 bytes, as WebAuthn allows.
  id            text primary key check (id ~ '^[A-Za-z0-9_-]+$' and char_length(id) between 16 and 1364),
  -- Its public key, COSE-encoded.
  public_key    bytea not null,
  sign_count    bigint not null default 0 check (sign_count >= 0),
  transports    text[] not null default '{}',
  -- What Martin called it as he made it ("iPhone"), so the settings can list it.
  name          text not null check (char_length(name) between 1 and 40),
  enrolled_with text not null unique references enrolment_codes (code_sha256),
  enrolled_at   timestamptz not null default clock_timestamp(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Sessions, kept on the server: the browser holds a random id, and the store its SHA-256. Eight hours from signing in
-- (SESSION), set by the store from its own clock, with no idle timeout; the passkey given again is recorded when it is. Signing out ends one, and an
-- ended session stays ended.
create table sessions (
  id_sha256     text primary key check (id_sha256 ~ '^[0-9a-f]{64}$'),
  passkey       text not null references passkeys (id),
  signed_in_at  timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '8 hours',
  stepped_up_at timestamptz,
  ended_at      timestamptz,
  ended_by      text check (ended_by in ('sign-out', 'sign-out-everywhere', 'revoked')),
  check (expires_at > signed_in_at and expires_at <= signed_in_at + interval '8 hours'),
  check ((ended_at is null) = (ended_by is null))
);

create index sessions_passkey on sessions (passkey) where ended_at is null;

-- WebAuthn's challenges, each used once: to enrol (with the code it was asked for), to sign in, or to give the passkey
-- again in a session. A challenge is sent to the browser, so it is no secret, and is kept as it is.
create table webauthn_challenges (
  challenge   text primary key check (challenge ~ '^[A-Za-z0-9_-]{22,128}$'),
  purpose     text not null check (purpose in ('enrol', 'sign-in', 'step-up')),
  session     text references sessions (id_sha256),
  code_sha256 text references enrolment_codes (code_sha256),
  created_at  timestamptz not null default clock_timestamp(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  check (expires_at > created_at),
  check ((session is not null) = (purpose = 'step-up')),
  check ((code_sha256 is not null) = (purpose = 'enrol'))
);

-- What may change, and only once: a code is used once, a passkey revoked once, a session ended once, a challenge used
-- once. Grants hold each role to the columns it may set; this holds every role to setting each only once.
create function signing_in_once() returns trigger language plpgsql as $$
begin
  -- The column that is set once, and what to say when it is set already.
  if to_jsonb(old) ->> tg_argv[0] is not null then
    raise exception '%', tg_argv[1];
  end if;
  return new;
end
$$;

create trigger enrolment_codes_once before update on enrolment_codes
  for each row execute function signing_in_once('used_at', 'an enrolment code is used once');
create trigger passkeys_once before update on passkeys
  for each row execute function signing_in_once('revoked_at', 'a revoked passkey stays revoked');
create trigger sessions_once before update on sessions
  for each row execute function signing_in_once('ended_at', 'an ended session stays ended');
create trigger webauthn_challenges_once before update on webauthn_challenges
  for each row execute function signing_in_once('used_at', 'a WebAuthn challenge is used once');

-- At most two passkeys held at once, counted one enrolment at a time.
create function passkeys_at_most_two() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtext('passkeys'));
  if (select count(*) from passkeys where revoked_at is null) >= 2 then
    raise exception 'Martin holds two passkeys already: revoke one before enrolling another';
  end if;
  return new;
end
$$;

create trigger passkeys_at_most_two before insert on passkeys
  for each row execute function passkeys_at_most_two();

-- Revoking a passkey ends every session signed in with it, whoever revokes it.
create function passkeys_revoke_sessions() returns trigger language plpgsql as $$
begin
  update sessions set ended_at = new.revoked_at, ended_by = 'revoked'
  where passkey = new.id and ended_at is null;
  return null;
end
$$;

create trigger passkeys_revoked after update of revoked_at on passkeys
  for each row when (old.revoked_at is null and new.revoked_at is not null)
  execute function passkeys_revoke_sessions();

-- The admin service: Martin's commands and the full events, and the tables of signing in.
grant select, insert (id, public_key, sign_count, transports, name, enrolled_with),
  update (sign_count, last_used_at, revoked_at) on passkeys to factory_admin;
grant select, update (tries, used_at) on enrolment_codes to factory_admin;
grant select, insert (id_sha256, passkey), update (stepped_up_at, ended_at, ended_by)
  on sessions to factory_admin;
grant select, insert (challenge, purpose, session, code_sha256, expires_at), update (used_at), delete
  on webauthn_challenges to factory_admin;

-- The enrolment: a code, and revoking. It reads only what revoking needs, and lists the passkeys by name.
grant insert (code_sha256) on enrolment_codes to factory_enrol;
grant select (id, name, enrolled_at, last_used_at, revoked_at), update (revoked_at) on passkeys to factory_enrol;
grant select (passkey, ended_at), update (ended_at, ended_by) on sessions to factory_enrol;
