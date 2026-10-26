# Repositories and rulesets

A single path for change. Part of the [GitHub plane](README.md#github-plane).

- **v1:** one ruleset on `main`, the merge queue and the review gate (ADR 0014), and a `review` environment, applied to both public repositories by `scripts/github-settings.ts`.

## Where they live

Both public repositories are the organisation `the-roganator`'s, since GitHub offers the merge queue only to an organisation's repositories. `cv-software-factory-private` stays with Martin's account, `mrogan`: the Apps installed across the organisation, the review App on every repository there, must never reach the answer key, which only the scoreboard reads.

## The ruleset

| Ruleset | Requires | Bypass |
|---|---|---|
| `main` | Pull requests only, squash merges, required checks, `review` among them, linear and signed history, the merge queue | Nobody |

There is no rule that a branch be up to date with `main`: the queue tests each pull request on `main` as it will be, with those ahead of it, on a commit of its own, and every required check runs there too. Each is squashed, every one of a group must pass, up to five are tested at once, and a group whose checks say nothing within the hour leaves the queue. GitHub's own review rule is not used: the queue admits only a pull request that meets every rule, so review is a check it can wait for.

## The review gate

`review` is required from the review App alone (App ID `5470762`), so no workflow's job of that name stands in for it. `review.yml` judges each pull request with `scripts/review-gate.ts`, and posts the check as the review App: it passes when Martin opened the pull request, by his account's id, or approved its head after the last push. `review-requested.yml` asks for it when a pull request opens, moves or is edited, on a review, and in the merge queue, and `review.yml` runs only after it, on `workflow_run`, as `main` has it, never on `pull_request_target`. Every other required check runs in the queue too: `check.yml` and `pr-title.yml`, and the app's gates (`app-gates.yml`), which the app's repository calls from its queue, read-only and with no secret.

The review App's key is kept only in each repository's `review` environment, as `REVIEW_APP_PRIVATE_KEY`, which only workflows on `main` may use. `github-settings.ts --check` reports the environment as drift if it is missing or any other branch may use it.

## Also

- **CODEOWNERS** on workflows, policy and test config.
- **Actions** pinned by SHA.
- **Copilot** reviews Martin's own pull requests, by his account's automatic code review rather than a ruleset, which cannot tell one author from another. So Dependabot's and the App's go without it.
  - It follows `.github/copilot-instructions.md`.
  - Its comments, like any, must be resolved before a merge.
