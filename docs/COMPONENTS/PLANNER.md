# Planner

An agent: writes a spec for each ticket, and for each improvement Martin asks for. Part of the [factory plane](README.md#agents).

- **Reads:** tickets; Martin's improvement requests.
- **Produces:** a spec per work item: outcome, acceptance criteria, scope, risk, rollout; and for an improvement, its title, its flag and its pages.
- **v1:** `line/agents/planner.ts`, in a [runner](AGENT-RUNNERS.md) at the commit the fix starts from, with 30 turns and 15 minutes.

## Its prompt

- **The ticket's public view**, and each sense's signal by its typed fields (`line/agents/evidence.ts`): one for each version of the app a sense saw the problem in, so every version rolled back on it.
- **Never a report, and no log message,** since an app may log what a visitor typed, quoted or not. A log signal is told by its route, its requests and its lines at each level, and every route is cut at its query.
- **On a fresh pass after Verify,** each time a released fix's signal persisted, and each time the ticket reopened after a fix that shipped, so it finds out why the last fix did not hold before it plans another.
- **Martin's answers** to its earlier questions and rejections, with what he was asked, and to the holds that send the work back to it: a `scope` hold's says what the fence printed or which files the coder needs and why (the coder's words, which no criterion may quote), and approving it asks it to take them into the scope, never a protected path ([holds](ORCHESTRATOR.md#holds-and-martins-answers)).

For an improvement, instead of a ticket and its signals:

- **Martin's words,** through the redactor, as the [request](ORCHESTRATOR.md#an-improvement) has them, and the title made from them.
- **Where the change goes, not a diagnosis.** Nothing is broken: it reads the code that serves the pages the change shows on, and builds and tries nothing, since the coder builds it test first.
- **How it ships:** behind a flag of its own, which the app reads with `await request.flag('<name>')`, off until Martin turns it on ([feature flags](FEATURE-FLAGS.md)).
- **The flags taken:** every flag another improvement Martin asked for has named, open or closed, since a closed one's code stays in the app behind its flag.

## Its result

A spec, a rejection or a question, read with Zod, each with up to five `findings`. A result the schema refuses fails the step, and the next attempt is told why.

### A spec

- **Criteria.** Each criterion names what in the ticket's evidence asks for it (`from`: the ticket, a numbered signal, or Martin's answer), and quotes the words there that do (`quote`). The schema refuses a spec whose quote is not in what its criterion names, as the prompt told it, before any review; whether the words ask for the criterion is the [reviewer's](REVIEWER.md) to judge. One nothing asks for does not belong in the spec.
- **Scope.** A plain path in the repository. It never names `.github/`, `deploy/` or a path the app's CODEOWNERS gives Martin at that commit, which the line reads through the [GitHub worker](GITHUB-WORKER.md).
- **Risk.** A spec tagged `out-of-scope` holds for Martin before the coder starts ([approval routing](APPROVAL-ROUTING.md)).

### An improvement's spec

It has the fields a fix's has, and the schema refuses one without these:

- **`title`:** what the work item is, in a few words; it names the work item from then on, in place of the one made from Martin's first sentence.
- **`flag`:** a flag's name as the app names them, lower-case words joined by hyphens: never `flag-set-revision`, and none another improvement has named.
- **`pages`:** one to six pages a visitor opens to see the change, by their paths, which Verify pictures with the flag off and on.
- **`withFlag` on each criterion:** the side of the flag it holds on, with at least one on each: `on` for what the change does, and `off` for the app as it is now, which is what keeps the change from reaching anyone until Martin turns the flag on.
- **Each criterion from what Martin asked:** `from` names the request or his answer, and the quote is there.

A risk tagged `out-of-scope` means beyond what Martin asked. Every improvement's spec is held for his approval before any code ([an improvement](ORCHESTRATOR.md#an-improvement)).

### A rejection or a question

It rejects what it cannot make testable, or what only a protected path would fix, and asks Martin what only he can say. It rejects an improvement that needs a protected path, the app's flag context (`src/flags/`) among them, or that would keep anything on a visitor's device, such as a cookie or anything in the browser's storage: what may be kept there is decided in this repository, which the line cannot write. Both hold the work item ([holds](ORCHESTRATOR.md#holds-and-martins-answers)):

- his answer to either reaches every later plan, with what he was asked;
- rejecting closes the work item, and so does approving the planner's rejection.

### Findings

Anything else it notices is a finding: a page, its route and a sentence.

- The page and the route are paths without a query: one that names a query is cut at it, not refused, and a query the defect needs is in the sentence.
- The line leaves it in triage's inbox as a signal from the planner, naming the work item it was planning, once for the work item however often it plans ([triage](TRIAGE.md#the-planners-findings)).
- Its words are kept from every public view and every agent, as a report's are.
