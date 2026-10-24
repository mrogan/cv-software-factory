-- A session lasts 30 minutes from signing in (SESSION in policy/access.ts), however busy, with no idle timeout; the
-- store still sets the end from its own clock. Sessions already kept whose end is further than that from their sign-in
-- end 30 minutes after it, so the check holds for every row: a live one already older ends now, and Martin signs in
-- again. An ended session's end is cut too, which its trigger otherwise refuses; nothing else about it changes.

alter table sessions disable trigger sessions_once;
update sessions set expires_at = signed_in_at + interval '30 minutes'
where expires_at > signed_in_at + interval '30 minutes';
alter table sessions enable trigger sessions_once;

alter table sessions alter column expires_at set default now() + interval '30 minutes';
-- 0023's check had the name Postgres gave it; this one has its own.
alter table sessions drop constraint sessions_check;
alter table sessions add constraint sessions_lasts
  check (expires_at > signed_in_at and expires_at <= signed_in_at + interval '30 minutes');
