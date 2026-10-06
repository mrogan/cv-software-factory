-- A handback whose effects the line has not finished: what the agent handed back, and what each write in GitHub it
-- has done so far gave back. Kept so that when GitHub or the store fails part-way, the line tries the effects again
-- without running the agent again, and does no write twice. Cleared when the work item moves on.
alter table line add column effects jsonb;
