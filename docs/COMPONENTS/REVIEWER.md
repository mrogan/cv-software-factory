# Reviewer

An agent: reviews the fix once the gates pass. Part of the [factory plane](README.md#agents).

- **Reads:** the ticket's public view and what the senses saw, Martin's answers at Plan, the pull request's diff, the spec, and the app's `docs/REVIEWERS.md` at the base.
- **Produces:** a comment review, a check run, and its findings.
- **v1:** `line/agents/reviewer.ts`, in a [runner](AGENT-RUNNERS.md) at the pull request's head with its base beside it, with 30 turns and 15 minutes.

## What it holds the change to

- **The rules as they are at the base,** so a change cannot loosen them.
- **The diff,** against the coder's claims.
- **The spec, against the ticket,** with Martin's answers as part of the ticket, as well as the diff against the spec.

| It finds | Finding | Goes to |
|---|---|---|
| A criterion the ticket and Martin's answers do not ask for | Blocking, citing that criterion and the ticket. The schema makes such a review an escalation, in every autonomy mode, since the coder cannot put a spec right | Martin, as `beyond-ticket` |
| A change that goes beyond a sound spec | Blocking, citing the spec or a rule | The coder |

## Its result

Read with Zod:

- **a verdict:** approved, changes requested, or escalated to Martin;
- **a note;**
- **up to 20 findings,** each anchored to a line, blocking or not, citing a rule's number, a criterion of the spec or the ticket, in at most 300 characters.
- **in a later review, what is answered:** the numbers of the findings the review before blocked on that the change now puts right. One it still holds is left out, and given again as a finding of this review.

## What the line does with it

The line posts it through the [GitHub worker](GITHUB-WORKER.md) (`line/review.ts`), each once for a handback:

1. the check run `factory review`, which no ruleset requires: a signal, never a gate;
2. a comment review, with a finding the diff does not show in its body;
3. in a later review, a reply on the thread of each earlier finding it finds answered, naming the commit reviewed, and the thread resolved. The app's `main` merges nothing with a review thread open, so a finding put right no longer waits for Martin to resolve it by hand. A thread is found by its first comment, the App's, as the review wrote it, on the line it was made on; one the review gives again word for word stays open. GitHub refusing to resolve one does not hold the work item: Martin resolves it by hand.

Each is done in that order, so GitHub failing part way through never runs the reviewer again, and tries only what is left.

- **Blocking findings** go back to the coder's session.
- **After two reviews**, what still blocks holds for Martin, as does an escalation. His answer sends the work round again, his approval stands in for the reviewer's, and rejecting closes it ([holds](ORCHESTRATOR.md#holds-and-martins-answers)).

## Counting the rules

`factory reviews rules` counts findings by rule from the event store, so a rule never cited can go, and one cited often can become a lint rule or move into `AGENTS.md`.
