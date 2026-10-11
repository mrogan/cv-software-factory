-- The scoreboard's role. It reads the events, to count tickets against the answer key, and appends `score.updated`;
-- it can do nothing else. It may read the store's kind, which every append's check reads (events_one_kind), but not
-- add one: it appends only to a store that already holds real events. It reads no other table, and the answer key is
-- never in the database.
do $$
begin
  create role scoreboard_writer login;
exception when duplicate_object or unique_violation then null;
end
$$;

grant usage on schema public to scoreboard_writer;
grant select, insert on events to scoreboard_writer;
grant select on store to scoreboard_writer;

-- Its pod holds the answer key, so the role may append its own figures to a real store and nothing else: taken over,
-- it still could not write the line's history, or a score among the samples. A trigger runs as the role that appends,
-- so `current_user` is the scoreboard's.
create function events_scoreboard_only_scores() returns trigger language plpgsql as $$
begin
  if current_user = 'scoreboard_writer'
     and (new.type <> 'score.updated' or new.actor <> 'scoreboard' or new.work_item is not null) then
    raise exception 'the scoreboard appends its own figures and nothing else, so it refuses %', new.type;
  end if;
  if current_user = 'scoreboard_writer' and new.sample then
    raise exception 'the scoreboard counts real tickets only, so it appends nothing among samples';
  end if;
  return new;
end
$$;

create trigger events_scoreboard_scores before insert on events
  for each row execute function events_scoreboard_only_scores();
