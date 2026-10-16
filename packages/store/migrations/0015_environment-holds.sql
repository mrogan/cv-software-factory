-- A sense's new problem seen while what the sense reads was not healthy is held for Martin as a burst is, with its
-- cause the environment. Triage looks for both kinds of hold still waiting with each signal that would open a ticket,
-- so the burst holds' index takes in the environment's too.
create index events_held_signals on events (seq)
  where type = 'hold.started' and payload->>'cause' in ('burst', 'environment');
drop index events_burst_holds;
