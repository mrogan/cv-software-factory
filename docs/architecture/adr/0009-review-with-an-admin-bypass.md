# 0009: Code-owner review on main, with a bypass for the admin's own pull requests

## Decision

`main` in both public repositories has two rulesets. One holds everything but review: changes arrive only by pull request, squash-merged, with signed and linear history, once the required checks pass. Nobody bypasses it. The other holds review: one approval, from a code owner, given after the last push. The repository's admin role may bypass this one, and only when merging a pull request.

Martin is the code owner and the only admin. The factory's GitHub App is neither, and cannot bypass either ruleset.

## Why

The factory opens pull requests as its App: its fixes, and the deploy and release pull requests. Each of those must wait for Martin, so review has to be required. But every other pull request is Martin's, and GitHub never counts an author's approval of their own pull request, so required review alone would leave his changes unmergeable.

The alternatives each give something up:

- **A second account, or the App, approving Martin's pull requests** would satisfy the rule without anyone reviewing anything. That is theatre, and a demo of guardrails cannot rest on it.
- **Not requiring review** leaves the factory's pull requests guarded only by the checks, and the checks are what an agent is trying to pass.
- **One ruleset with an admin bypass** would let Martin skip the checks, signing and linear history too, not just review.

Splitting the rules keeps every change on the same path: a pull request, its checks, a signed squash commit. Only the approval Martin cannot give himself is bypassed, and the merge records that he did.

## Consequences

- Martin merges his own pull requests through the bypass (GitHub's "merge without waiting for requirements to be met", for review only). The checks still have to pass.
- Every pull request the App opens waits for Martin's approval, whatever it changes.
- Approval counts only after the last push, so the App updates its pull requests with `main` only before anyone has approved them. An approved App pull request that falls behind `main` needs updating before it can merge, and whoever updates it is the last pusher: if Martin does, his own approval no longer counts, and the way through is to update it and merge with the bypass.
- Dependabot's pull requests wait for Martin's approval too.
- The rulesets are applied by hand, so `scripts/github-settings.ts --check` says whether the live ones still say what the script does, such as a bypass widened or an actor added in the browser. A test pins the invariants: no bypass on the first ruleset, the admin role alone with `pull_request` on the second, and never the App.
- OpenSSF Scorecard's Branch-Protection check reads the rulesets and docks the admin bypass. The score is recorded in milestone 5's results.
- `scripts/github-settings.ts` applies both rulesets to both repositories.
