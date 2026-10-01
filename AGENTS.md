# AGENTS.md

Software Factory: AI agents and deterministic gates that look after a live web app, built by Martin Rogan as a portfolio demo.

Read [`docs/INTENT.md`](docs/INTENT.md) first: why this exists and the bar everything is held to. Then [`docs/AGENTS.md`](docs/AGENTS.md), which signposts the specification and other docs.

Everything you write here is public and part of the demo. Write for a thoughtful reviewer.

## Working here

```sh
mise install && pnpm install   # the pinned toolchain, dependencies and git hooks
make check                     # what CI requires: lint, types, tests, design tokens, manifests
pnpm dev                       # the console on :8080, restarting on change
make up / make status / make down
```

The inner loop runs on the host, not through GitOps. With the cluster up, forward its collector and Postgres:

```sh
kubectl --context k3d-software-factory -n telemetry port-forward svc/otel-collector 4318 &
kubectl --context k3d-software-factory -n factory port-forward svc/postgres 5432 &
```

- Node 24 runs TypeScript directly: erasable syntax only, `.ts` extensions in imports, no build step.
- Commits and pull request titles are Conventional Commits (`scripts/commit-msg.ts` checks both). Pull requests are squash-merged; nothing is pushed to `main`.
- `deploy/` is GitOps: Argo CD deploys what is on `main`, so a change there reaches the cluster only when it merges.
- Files listed in `.github/CODEOWNERS` are the rules of the line. Change them only when Martin asks.
- Merging is Martin's call, and so is approving the held check runs on a pull request a workflow opened (deploy, release).
- pnpm installs no release younger than a day, runs no dependency's install script unless `pnpm-workspace.yaml` allows it, and refuses a provenance downgrade. When it refuses, find out why; an exception goes in that file with its reason.
- Refresh a Dependabot pull request with `@dependabot rebase` or `@dependabot recreate`. Don't close it: that tells Dependabot to skip the version.
- A follow-up with no home yet goes in [`docs/PLAN/BACKLOG.md`](docs/PLAN/BACKLOG.md), not in a code comment.
