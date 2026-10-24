-- Triage closes a suggestion Martin rejects, as it closes a finding he rejects, so it looks for the suggestions still
-- held after each event appended, as it looks for the findings: their holds have an index of their own too.
create index events_suggestion_holds on events (seq) where type = 'hold.started' and payload->>'cause' = 'suggestion';
