-- The factory's writer goes. Every worker connects as its own role (0022), Martin's make targets as his (0023), and
-- nothing logs in as `factory_writer` any more, so the grants it kept on every table are taken away and the role with
-- them (#435).
--
-- Its policies first: the ones that name it alone go, and the ones it shares keep their other roles.
drop policy inbox_writer_reads on inbox;
drop policy inbox_writer_sends on inbox;
drop policy inbox_writer_triages on inbox;
drop policy inbox_writer_prunes on inbox;
drop policy looks_writer on looks;
alter policy events_read on events to factory_worker, scoreboard_writer, factory_admin, factory_operator;
alter policy events_not_his on events to factory_worker;

-- Then every grant it holds in this database, whatever granted it, and the role. Roles belong to the whole server: were
-- another database on it to grant the role something still, the role stays there, unable to log in and holding nothing
-- here.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'factory_writer') then
    drop owned by factory_writer;
    begin
      drop role factory_writer;
    exception when dependent_objects_still_exist then
      alter role factory_writer nologin password null;
    end;
  end if;
end
$$;
