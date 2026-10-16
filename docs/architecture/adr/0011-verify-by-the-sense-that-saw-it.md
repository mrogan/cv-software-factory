# 0011: Verify by the sense that saw the defect, and the canary is a sense

## Decision

A work item closes as verified only when, after its release is promoted, the sense that first saw its ticket's defect looks again at the new version alone and finds that the signal has cleared. Each sense looks its own way (`line/verify.ts`):

- a probe or the crawler: the same check, run again against the stable Service by the probes worker, passes twice in a row;
- an alert on an objective: the alert's own expression, over the new version's requests to the route, stays inside the objective for a window with enough requests;
- the log watcher: the same error pattern is absent from the new version's logs for a window with traffic, or, for a missing log or wrong metrics, the metrics, the log and the traces agree again on the route;
- the canary: the measure that failed passes in a promoted release that carries the fix.

A ticket only a visitor's report or the planner saw holds for Martin, since no sense can look again. The windows and counts are human-owned (`policy/release.ts`).

A failed canary analysis is a signal from a sense of its own, `canary`, one for each measure that failed, and triage treats it as any sense's. Its `*` route means routes the analysis could not narrow to one (the canary did worse on more than one, or on none it could name), not that the defect is on every page, so it matches only another canary `*`, and its ticket is titled "<class> in a canary release".

## Why

- **The question is the ticket's, so the answer must be too.** A ticket is a fingerprint a sense saw. Asking that sense again, in its own terms, is the one test that can fail for the reason the ticket exists. A general health check would pass a fix that cleared nothing, since the app is broken on purpose and the rest of its faults are still there; and a check of something else would close a ticket on evidence that never saw its defect.
- **Not the canary's promotion.** A promoted release did no worse than its baseline. That says the fix broke nothing, not that it fixed anything: the baseline had the defect too. Only the canary's own tickets can be verified this way, since the measure that failed is the thing they are about.
- **Not the gates.** The journeys gate ran the checks against containers in a GitHub runner, before the merge. Verify looks at what visitors are served, after the release, which is what the scoreboard counts.
- **At the new version only.** Each look is scoped to the released version (`service_version`, or the version `/version` reports), so the version it replaced cannot make a cleared fix look as if it persists, nor its quiet hours make a broken one look cleared. A look that cannot tell, for too little traffic or a check that could not finish, says so and looks again; it never clears on too little.
- **Martin, where no sense can look.** A report's words cannot be run again. Rather than ask a model whether the defect has gone, which would make a model the judge of a fix (guardrail 2), the work item holds for Martin with every page against the version before.
- **The canary as a sense,** rather than the rollback going to triage as a metrics or probe signal. The rollback's evidence is a comparison with a baseline, which no other sense makes, and its route is a guess from where the canary did worse. Under its own name it is told apart in triage, verified by its own rule, and counted for itself; under another's, a rollback would be verified by a sense that never saw it, and a `*` from Prometheus's routes would swallow every ticket of its class.

## Consequences

- The line reaches what each sense reads: the probes' verify port, Prometheus, Loki and Tempo. Its image has no browser, so the probes worker runs the checks, on a port only the line may call.
- A fix that cleared on the canary's numbers but not on its own sense persists, and goes back to Plan with that verification as evidence, once; then it holds.
- One fingerprint, one ticket holds through a release: a verified ticket whose signal returns reopens, rather than a second ticket opening for the same defect.
- A release found live, which no analysis judged, cannot verify a canary ticket, nor one whose last step did not pass the measure: it holds for Martin.
- Adding a sense means saying how it verifies: `BY_SOURCE` is a record over every signal source, so the code does not compile until it does.
