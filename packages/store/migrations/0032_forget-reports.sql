-- A visitor's report is kept for a while, not for ever (REPORTS in policy/triage.ts): once old enough, its text goes
-- from the events, and its row from the inbox. `forgetReports` in packages/store/src/reports.ts says what goes.
--
-- The events stay append-only but for that one change. An update is refused unless all it does is take the text out
-- of a report: `report.text` from a `signal.received`, or `state.report.text` from a `judgement.made`. Every other
-- column stays as it was, the public view among them, which never had the text. The payload is still valid at its
-- version, as a report read from a public record has no text either, so every projection reads it as before. A
-- delete or a truncate is refused as ever.
create function events_only_forget() returns trigger language plpgsql as $$
begin
  if to_jsonb(new) - 'payload' = to_jsonb(old) - 'payload'
     and ((old.type = 'signal.received' and old.payload -> 'report' ? 'text'
           and new.payload = old.payload #- '{report,text}')
       or (old.type = 'judgement.made' and old.payload -> 'state' -> 'report' ? 'text'
           and new.payload = old.payload #- '{state,report,text}')) then
    return new;
  end if;
  raise exception 'events are append-only, so % is refused', lower(tg_op)
    using hint = 'Append a new event instead; reading upcasts older versions. Only a report''s text may be taken out.';
end
$$;

drop trigger events_append_only on events;
create trigger events_append_only before delete on events
  for each row execute function events_refuse_change();
create trigger events_only_forget before update on events
  for each row execute function events_only_forget();

-- The reports whose text is still kept, by when they reached the store: a few rows, as their text goes.
create index events_report_text on events (appended_at)
  where type = 'signal.received' and payload ->> 'sense' = 'report' and payload -> 'report' ? 'text';

-- Triage forgets them, as it prunes the inbox, through this and nothing else: it has no right to update an event or a
-- signal, and no right to delete a report from the inbox. The function runs as its owner, the one the migrations run
-- as, so it does only what it says, and never sooner than it says: a cut later than 29 days ago (REPORT_TEXT.keepDays,
-- which a test holds this to) is taken as 29 days ago, so a caller cannot erase a report, a quarantined one's evidence
-- among them, before its time.
--
-- Of a real store, and never of samples, whose reports are invented:
--
-- - the text of every visitor's report that reached the store before `before`, and of each judgement Jev made of it,
--   appended with it (the same work item and time). A planner's finding is the factory's own words, and stays;
-- - every report in the inbox received before then, triaged or not. The log watcher takes up from the newest report
--   the inbox holds, or from a day back when it holds none; a report that old is far older than either, and than
--   what Loki keeps, so nothing reads one again.
create function forget_reports(before timestamptz, out texts integer, out reports integer)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  judgements integer;
begin
  before := least(before, now() - interval '29 days');
  with sent as (
    select work_item, ts from public.events
    where type = 'signal.received' and payload ->> 'sense' = 'report' and payload -> 'report' ? 'text'
      and appended_at < before and not sample
  )
  update public.events judged set payload = judged.payload #- '{state,report,text}'
  from sent
  where judged.type = 'judgement.made' and judged.work_item = sent.work_item and judged.ts = sent.ts
    and judged.payload -> 'state' -> 'report' ? 'text';
  get diagnostics judgements = row_count;

  update public.events set payload = payload #- '{report,text}'
  where type = 'signal.received' and payload ->> 'sense' = 'report' and payload -> 'report' ? 'text'
    and appended_at < before and not sample;
  get diagnostics texts = row_count;
  texts := texts + judgements;

  delete from public.inbox where sense = 'report' and received_at < before;
  get diagnostics reports = row_count;
end
$$;

revoke all on function forget_reports(timestamptz) from public;
grant execute on function forget_reports(timestamptz) to factory_triage;
