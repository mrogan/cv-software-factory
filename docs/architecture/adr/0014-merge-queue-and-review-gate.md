# 0014: The repositories move to an organisation for the merge queue, and review becomes a gate

## Decision

Both public repositories move from Martin's account, `mrogan`, to the organisation `the-roganator`, on GitHub's Free plan, so that `main` can use GitHub's merge queue. The queue replaces the rule that a pull request be up to date with `main` before it merges.

GitHub's review rule, the `main: review` ruleset and its admin bypass (ADR 0009), goes, and a required check takes its place: `review`, posted by a GitHub App of its own, the review App, and required from that App alone. It passes when

- Martin opened the pull request from a branch in the repository, known by his account's id, `6206459`, never by his login; or
- Martin's latest verdict on the pull request approves the commit at its head: an approval given before the last push, dismissed, or followed by his asking for changes does not count, and nobody else's approval counts at all.

The `main` ruleset, which nobody bypasses, keeps everything else: pull requests only, squash merges, signed and linear history, the required checks, now with `review` among them, and the merge queue.

### How the gate runs

- **Only `main`'s copy of the gate runs with the App's key.** `review.yml` runs on `pull_request_target` and `workflow_run`, which run the workflow as the default branch has it, and its job uses the `review` environment, which holds the App's key and which only `main` may use. A pull request into another branch runs that branch's copy, which the environment refuses. The gate (`scripts/review-gate.ts`) reads the pull request and its reviews through the API and never checks out, builds or runs its code.
- **A review asks for the gate again.** `pull_request_target` does not fire on a review, and `pull_request_review` runs the pull request's own copy of a workflow. So `review-requested.yml` runs on a review, holds no secret and writes nothing, and only finishes; its run starts `review.yml` on `main` through `workflow_run`, which reads the verdict afresh and posts it on the pull request's head. Anyone who can push a branch can make a workflow of that name run, so the request says only which pull request to look at: a forged one makes the honest gate look again.
- **The merge queue's commit gets the check too.** The queue tests each pull request on a commit of its own, on a branch `gh-readonly-queue/main/pr-<number>-…`, and every required check must pass there. Workflows that run on `merge_group` run as that commit has them, which carries the pull request's change, so the gate never runs there: `review-requested.yml` runs, and `review.yml` on `main` judges the pull request the branch names, as it is now, and posts on the queue's commit. The environment's branch rule allows `main` alone; nothing on the queue's branches ever holds the key.
- **`check.yml` and `pr-title.yml` run on `merge_group` too,** so the queue's commit reports every required check. In the queue, `check.yml` runs everything, whatever the pull request is; the title check reads the title from the pull request the queue's branch names.

### The order of the move

1. Before the transfer: the gate, the triggers above, and an admission policy that admits images under either owner, signed by `build.yml` on `main` of the repository under either. The gate runs, and posts nothing until its App is set up; nothing requires it. The app's repository gets the same, calling this repository's `review.yml` at a pinned commit, as it calls the title check.
2. Martin makes the review App in the organisation, with permission to write checks and nothing else, installs it on both repositories, and puts its Client ID and key in each repository's `review` environment; transfers both repositories; and installs the factory's App on the organisation.
3. After the transfer, in a pull request of its own: the repositories' names wherever they are written, the settings (`scripts/github-settings.ts`: the queue, `review` required from the review App, no up-to-date rule, `main: review` gone), Kyverno's refusals taken again under the new policy, and the line's and the `implement` skill's ways of keeping a branch up to date, which the queue makes needless.
4. Once only images built after the move run, the old owner's names and identities leave the admission policy.

The transfer happens before the app's next pull request opens, or after that pull request's pin has synced, never between: its pin and the journeys image its canary analysis runs would be caught between two signer identities.

## Why

Every merge makes every other open pull request out of date, and the up-to-date rule makes each run its gates again: merging *n* pull requests one after another runs them up to *n*(*n*+1)/2 times, browser tests and image builds included. The merge queue tests each pull request once, on `main` as it will be, and is offered only to repositories an organisation owns.

The queue cannot sit beside GitHub's review rule here. A pull request enters the queue only once every rule is met, and a bypassed rule is not met. Tried on 25 October 2026, in a throwaway repository in the organisation with this repository's two rulesets and the queue: with the queue in `main`, Martin's own pull request, unreviewed, was refused entry ("New changes require approval from someone other than the last pusher"), and a merge with `--admin` was refused because changes must go through the queue; with the queue in `main: review`, entry was refused the same way, and `--admin` merged around the queue. So review has to be something the queue can wait for: a check.

- **A check posted by an App of its own,** rather than by the factory's App or by a plain Actions job. The factory's App opens the pull requests the gate holds, so it must never post the verdict that lets them merge. A job's check is GitHub Actions', and any pull request that changes a workflow can add a job of the same name; requiring the check from one App's integration means only the holder of its key can post it.
- **Martin opened it, or approved its head,** because Martin is the only reviewer: every pull request that is not his waits for him, the App's, Dependabot's and anyone's, as `main: review` made them, and his own merge, as the bypass let them, with the checks still required.
- **By id, not login.** A login can be renamed, and the name then taken by someone else; an account's id never changes.
- **An organisation on the Free plan,** because the queue needs no paid plan for a public repository, and a move costs only names: GitHub redirects the repositories' URLs. It does not redirect GHCR's image names or the identity cosign certifies, which carry the owner, so the admission policy admits both owners' until the old images are gone.

## Consequences

- OpenSSF Scorecard's Branch-Protection check reads GitHub's review settings, not a check, so its score falls from 8 to about 3 to 5: it wants an approval rule on the branch. Code-Review is 0 already, since nobody else reviews. Martin will not keep a rule only he can bypass to keep a score.
- GitHub no longer holds code owners' review: Martin is the only code owner, and the gate holds every pull request he did not open for his approval, those that change the files CODEOWNERS names included.
- A pull request Martin opened passes whoever pushes to it after him, as the bypass did. Only Martin, Dependabot and the factory's App push branches here, and the other two only to branches they opened.
- Until the App is set up, the gate says its verdict in its run and posts nothing. Until the settings change, it is required by nothing.
- The line does not read `review` as one of a pull request's gates: it waits for Martin, who looks once the gates are done.
- The `review` environment is the only place the review App's key is kept. Its branch rule, `main` only, is set by hand before the key is added, and is what keeps a pull request into another branch from using it.
- In the queue, every pull request runs every check, a deploy or release pull request's browser tests and image builds too, since a merge group carries no author to tell them apart by. That is one full run for each merge, in place of one for each pull request still open.
- ADR 0009 holds until the settings change after the transfer, and this decision replaces it then.
