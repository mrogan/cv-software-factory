# Reviewing pull requests here

Software Factory is a portfolio demo: AI agents and deterministic gates looking after a live web app. Everything in
it is public and read by reviewers, so the bar is best practice and scrupulous hygiene, and simple beats clever
(`docs/INTENT.md`). Most pull requests are written by Claude Code and merged by Martin.

The gates already check lint, formatting, types, tests, design tokens, manifests and the pull request's title. Don't
comment on what they catch. Review the diff, not the code around it, and leave a comment only when it changes
something: a bug, a risk, a broken rule below, or a doc the change made untrue. Say which rule a comment rests on.

## The rules

From `docs/REVIEWERS.md`, which wins if the two disagree:

1. **Deep modules.** A module hides a decision behind a small interface. Prefer fewer, deeper modules to layers that
   only pass calls through or rename them.
2. **Check at the boundary, trust inside.** What comes from outside (HTTP, a provider, the store, the environment) is
   parsed with Zod once, where it enters. Past that, the types are believed.
3. **Failures are typed.** An error a caller handles is a class with a kind, never matched on its message, and
   nothing is swallowed silently.
4. **Collaborators come in.** A module is given its store, log, clock and HTTP client, so a test can pass fakes; only
   the entry points wire real ones.
5. **Test at the seams.** Tests observe behaviour through a public boundary, never against internals.

## How this repository works

- Node 24 runs TypeScript directly: erasable syntax only, `.ts` extensions in imports, no build step. The console's
  browser code is the exception: Vite builds it.
- In the console, anything that runs every frame (a drag, a wipe, the reel settling) writes to the DOM through refs;
  React state changes only when the movement ends.
- Docs say how things are now, with no history of how they got there, and change in the same pull request as the code
  they describe. `docs/SPECIFICATION.md` is the source of truth; `docs/TERMS.md` holds the agreed words.
- A follow-up is a GitHub issue, never a `TODO` in the code.
- `deploy/` is GitOps: Argo CD deploys what is on `main`.
- Files in `.github/CODEOWNERS` are the rules of the line: workflows, rulesets, policy and gate configuration. A change
  that loosens one deserves a comment saying so, however small.
- GitHub Actions are pinned by full commit SHA, with the least `permissions` a job needs, and untrusted code runs
  under `pull_request`, never `pull_request_target`.
