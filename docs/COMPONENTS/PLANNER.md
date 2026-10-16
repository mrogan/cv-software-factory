# Planner

An agent: writes a spec for each ticket. Part of the [factory plane](README.md#agents).

- **Reads:** tickets; Martin's improvement requests.
- **Produces:** a spec per ticket: outcome, acceptance criteria, scope, risk, rollout.
- **v1:** `line/agents/planner.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from, with 30 turns and 15 minutes.

## Its prompt

- **The ticket's public view**, and each sense's signal by its typed fields (`line/agents/evidence.ts`): one for each version of the app a sense saw the problem in, so every version rolled back on it.
- **Never a report, and no log message,** since an app may log what a visitor typed, quoted or not. A log signal is told by its route, its requests and its lines at each level, and every route is cut at its query.
- **On a fresh pass after Verify,** each time a released fix's signal persisted, and each time the ticket reopened, so it finds out why the last fix did not hold before it plans another.
- **Martin's answers** to its earlier questions and rejections, with what he was asked.

## Its result

A spec, a rejection or a question, read with Zod, each with up to five `findings`. A result the schema refuses fails the step, and the next attempt is told why.

### A spec

- **Criteria.** Each criterion names what in the ticket's evidence asks for it (`from`: the ticket, a numbered signal, or Martin's answer), and quotes the words there that do (`quote`). The schema refuses a spec whose quote is not in what its criterion names, as the prompt told it, before any review; whether the words ask for the criterion is the [reviewer's](REVIEWER.md) to judge. One nothing asks for does not belong in the spec.
- **Scope.** A plain path in the repository. It never names `.github/`, `deploy/` or a path the app's CODEOWNERS gives Martin at that commit, which the line reads through the [GitHub worker](GITHUB-WORKER.md).
- **Risk.** A spec tagged `out-of-scope` holds for Martin before the coder starts ([approval routing](APPROVAL-ROUTING.md)).

### A rejection or a question

It rejects what it cannot make testable, or what only a protected path would fix, and asks Martin what only he can say. Both hold the work item ([holds](ORCHESTRATOR.md#holds-and-martins-answers)):

- his answer to either reaches every later plan, with what he was asked;
- rejecting closes the work item, and so does approving the planner's rejection.

### Findings

Anything else it notices is a finding: a page, its route and a sentence.

- The line leaves it in triage's inbox as a signal from the planner, naming the work item it was planning, once for the work item however often it plans ([triage](TRIAGE.md#the-planners-findings)).
- Its words are kept from every public view and every agent, as a report's are.
