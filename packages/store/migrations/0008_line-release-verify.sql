-- The line carries a work item past Martin's merge: it waits at Release for a release to carry it, and at Verify for
-- the sense that saw the defect to look again. A work item ends when it closes, no longer when it merges.
-- 0005 left the check unnamed, so Postgres named it by its column.
alter table line drop constraint line_stage_check;
alter table line add constraint line_stage_check
  check (stage in ('plan', 'build', 'gates', 'review', 'release', 'verify', 'held', 'ended'));

-- Work items that merged before, and have not closed, ended at their merge: they take their place at Release, and the
-- line carries them on from their events.
update line set stage = 'release', moved_at = clock_timestamp()
where stage = 'ended'
  and exists (select 1 from events e where e.work_item = line.work_item and e.type = 'pull-request.merged')
  and not exists (select 1 from events e where e.work_item = line.work_item and e.type = 'work-item.closed');
