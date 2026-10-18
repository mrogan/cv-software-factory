-- A work item whose spec shares a file with work in flight waits after Plan, until that work is verified or closed: a
-- stage of its own, so that it is neither in Plan nor waiting for Build, and the line still takes the next ticket.
alter table line drop constraint line_stage_check;
alter table line add constraint line_stage_check
  check (stage in ('plan', 'build', 'waiting', 'gates', 'review', 'release', 'verify', 'held', 'ended'));
