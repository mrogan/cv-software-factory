# Reviewing pull requests here

Software Factory is a portfolio demo: AI agents and deterministic gates looking after a live web app. Everything in
it is public and read by reviewers, so the bar is best practice and scrupulous hygiene, and simple beats clever
(`docs/INTENT.md`). Most pull requests are written by Claude Code and merged by Martin.

The gates already check lint, formatting, types, tests, design tokens and manifests. Don't comment on what they catch.

## The rules

Follow the rules in `docs/REVIEWERS.md`.

## How this repository works

- Node 24 runs TypeScript directly: erasable syntax only, `.ts` extensions in imports, no build step. The console's
  browser code is the exception: Vite builds it.
- In the console, anything that runs every frame (a drag, a wipe, the reel settling) writes to the DOM through refs;
  React state changes only when the movement ends.
- Docs say how things are now, with no history of how they got there, and change in the same pull request as the code
  they describe. `docs/SPECIFICATION.md` is the source of truth; `docs/TERMS.md` holds the agreed words.
- `deploy/` is GitOps: Argo CD deploys what is on `main`.
- Files in `.github/CODEOWNERS` are the rules of the line: workflows, rulesets, policy and gate configuration. A change
  that loosens one deserves a comment saying so, however small.
- GitHub Actions are pinned by full commit SHA, with the least `permissions` a job needs, and untrusted code runs
  under `pull_request`, never `pull_request_target`.
