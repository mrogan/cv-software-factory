-- A refusal from before version 3 names no guardrails: version 2 had none, and its upcaster gives it its mechanism's.
-- 0041 held such a refusal only to a mechanism version 2 knew, so a role that may append one could still write one
-- under any guardrails it chose, in its public view too, which the console reads and the Guardrails panel counts. This
-- holds it to naming none, in its payload and so in its public view, which 0041 holds to the payload.
--
-- The same restrictive policy, rewritten whole: `REFUSAL_READS` in `policy/refusals.ts`, which the grants test holds
-- it to.

alter policy events_refused_as_it_reads on events
  with check (type <> 'action.refused' or (
    public->'payload'->'mechanism' = payload->'mechanism'
    and public->'payload'->'guardrails' is not distinct from payload->'guardrails'
    and case when version >= 3
      then jsonb_typeof(payload->'guardrails') = 'array' and payload->'guardrails' <> '[]'
           and payload->'guardrails' <@ refusal_guardrails(payload->>'mechanism')
           and jsonb_array_length(payload->'guardrails')
               = (select count(distinct guardrail) from jsonb_array_elements(payload->'guardrails') as guardrail)
      else payload->>'mechanism' in ('token-permission', 'ruleset', 'egress-policy', 'admission-control', 'scope-fence')
           and payload->'guardrails' is null
    end));
