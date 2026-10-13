# Repositories and rulesets

A single path for change. Part of the [GitHub plane](README.md#github-plane).

- **v1:** two rulesets on `main` (ADR 0009), applied to both public repositories by `scripts/github-settings.ts`.

## The rulesets

| Ruleset | Requires | Bypass |
|---|---|---|
| `main` | Pull requests only, squash merges, required checks, linear and signed history | Nobody |
| `main: review` | A code owner's approval after the last push | The repository's admin, only to merge a pull request |

The bypass means Martin's own changes still go through a pull request and its checks, and the merge records the bypass, while every pull request the App opens waits for him.

## Also

- **CODEOWNERS** on workflows, policy and test config.
- **Actions** pinned by SHA.
- **Copilot** reviews Martin's own pull requests, by his account's automatic code review rather than a ruleset, which cannot tell one author from another. So Dependabot's and the App's go without it.
  - It follows `.github/copilot-instructions.md`.
  - Its comments, like any, must be resolved before a merge.
