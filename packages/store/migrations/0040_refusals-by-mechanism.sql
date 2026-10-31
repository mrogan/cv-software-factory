-- A refusal (`action.refused`) is appended only by the roles that may speak for its mechanism, as `policy/refusals.ts`
-- sets out: the line for the scope fence, for what the GitHub worker refused or GitHub refused it, for the review check
-- and for admission control; the gateway for its own refusals; triage for its typed judgement. The Guardrails panel,
-- the line's count of what pages Martin and the attacks' proofs count refusals, so a worker that untrusted input had
-- turned must not be able to make one up, or put one in another mechanism's name. The ruleset has no producer yet, and
-- may be appended by nobody.
--
-- A restrictive policy, so it holds whatever the permissive ones let through: Postgres ORs permissive policies, and
-- ANDs each restrictive one with them. It applies to every role, Martin's included: his command line appends a refusal
-- only as a sample (`make samples`), never as real work. The table is a function here, and the grants test holds it to
-- `policy/refusals.ts`, mechanism by mechanism, and inserts each mechanism as every role.

create function refusal_appenders(mechanism text) returns text[] language sql immutable parallel safe as $$
  select case mechanism
    when 'scope-fence' then array['factory_line']
    when 'github-guard' then array['factory_line']
    when 'token-permission' then array['factory_line']
    when 'review-gate' then array['factory_line']
    when 'admission-control' then array['factory_line']
    when 'gateway' then array['factory_gateway']
    when 'typed-judgement' then array['factory_triage']
    else array[]::text[]
  end
$$;

create policy events_refused_by_its_mechanism on events as restrictive for insert
  with check (type <> 'action.refused' or current_user = any (refusal_appenders(payload->>'mechanism'))
              or (current_user = 'factory_operator' and sample));

-- The console's server reads which role appended each event, a role's name and nothing private, so the panel can count
-- a refusal by who appended it.
grant select (appended_by) on events to console_reader;
