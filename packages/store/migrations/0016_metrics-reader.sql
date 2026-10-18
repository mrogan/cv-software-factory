-- The Postgres exporter's role. It reads the statistics any role may read (pg_stat_database, pg_locks, pg_settings and
-- the others the exporter asks), so it is granted nothing: no table, view or sequence of the store, and not
-- pg_read_all_stats, which would show it every session's query text, the migrations' `alter role ... password` among
-- them. Other sessions' state in pg_stat_activity is hidden from it: connections are counted from pg_stat_database
-- instead. Two connections at most, so a stuck exporter cannot take the ones the factory needs.
do $$
begin
  create role metrics_reader login connection limit 2;
exception when duplicate_object or unique_violation then null;
end
$$;
