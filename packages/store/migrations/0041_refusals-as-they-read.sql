-- A refusal reads in the console as its public view says, and the Guardrails panel counts it under the guardrails it
-- names. 0040 holds who may append each mechanism, from the private payload; this holds what the console reads to it.
--
-- - The public view names the same mechanism and guardrails as the payload, so a role that may append one mechanism
--   cannot show the console another: the console reads only the public view, which the writer makes.
-- - A refusal names only guardrails its mechanism shows (`policy/refusals.ts`), at least one, and each once, so a role
--   that may append a mechanism cannot count it under another's guardrails, or twice under its own. One from before
--   version 3 named none, and reads as showing its mechanism's: it may be only one of the mechanisms version 2 knew.
--
-- Another restrictive policy, ANDed with 0040's and with whatever the permissive ones let through. The grants test
-- holds the function to `policy/refusals.ts`, mechanism by mechanism, and inserts refusals that break each rule.

create function refusal_guardrails(mechanism text) returns jsonb language sql immutable parallel safe as $$
  select case mechanism
    when 'scope-fence' then '[11]'
    when 'github-guard' then '[1, 10]'
    when 'token-permission' then '[1]'
    when 'review-gate' then '[1, 2]'
    when 'gateway' then '[6, 7, 9]'
    when 'typed-judgement' then '[8]'
    when 'egress-policy' then '[5]'
    when 'admission-control' then '[3, 4]'
    when 'ruleset' then '[1]'
    else '[]'
  end::jsonb
$$;

create policy events_refused_as_it_reads on events as restrictive for insert
  with check (type <> 'action.refused' or (
    public->'payload'->'mechanism' = payload->'mechanism'
    and public->'payload'->'guardrails' is not distinct from payload->'guardrails'
    and case when version >= 3
      then jsonb_typeof(payload->'guardrails') = 'array' and payload->'guardrails' <> '[]'
           and payload->'guardrails' <@ refusal_guardrails(payload->>'mechanism')
           and jsonb_array_length(payload->'guardrails')
               = (select count(distinct guardrail) from jsonb_array_elements(payload->'guardrails') as guardrail)
      else payload->>'mechanism' in ('token-permission', 'ruleset', 'egress-policy', 'admission-control', 'scope-fence')
    end));
