# Repositories and rulesets

A single path for change. Part of the [GitHub plane](README.md#github-plane).

- **v1:** two rulesets on `main` (ADR 0009), applied to both public repositories by `scripts/github-settings.ts`.

## The rulesets

| Ruleset | Requires | Bypass |
|---|---|---|
| `main` | Pull requests only, squash merges, required checks, linear and signed history | Nobody |
| `main: review` | A code owner's approval after the last push | The repository's admin, only to merge a pull request |

The bypass means Martin's own changes still go through a pull request and its checks, and the merge records the bypass, while every pull request the App opens waits for him.

## The review gate

Both repositories are moving to the organisation `the-roganator` for GitHub's merge queue, which cannot sit beside `main: review` (ADR 0014). Its replacement is built and runs, and nothing requires it yet: `review.yml` judges each pull request, `scripts/review-gate.ts`, and posts the `review` check as the review App once that App is set up. It passes when Martin opened the pull request, by his account's id, or approved its head after the last push. `review-requested.yml` asks for it again on a review and in the merge queue, and `check.yml` and `pr-title.yml` run in the queue too. The rulesets above change after the transfer: the queue on `main`, `review` required from the review App alone, no rule that a branch be up to date, and `main: review` gone.

## Also

- **CODEOWNERS** on workflows, policy and test config.
- **Actions** pinned by SHA.
- **Copilot** reviews Martin's own pull requests, by his account's automatic code review rather than a ruleset, which cannot tell one author from another. So Dependabot's and the App's go without it.
  - It follows `.github/copilot-instructions.md`.
  - Its comments, like any, must be resolved before a merge.
