# AGENTS.md

Software Factory: AI agents and deterministic gates that look after a live web app, built by Martin Rogan as a portfolio demo.

Read [`docs/INTENT.md`](docs/INTENT.md) first: why this exists and the bar everything is held to. Then [`docs/AGENTS.md`](docs/AGENTS.md), which signposts the specification and other docs.

Everything you write here is public and part of the demo. Write for a thoughtful reviewer.

## Working here

```sh
mise install && pnpm install   # the pinned toolchain, dependencies and git hooks
make check                     # what CI requires: lint, types, tests, design tokens, manifests
pnpm dev                       # the console on :5173 with the samples, reloading on change
make e2e                       # the console in a browser, in the pinned Playwright image
make up / make samples / make status / make down
```

The inner loop runs on the host, not through GitOps. With the cluster up, forward its collector and Postgres; `pnpm dev` reads the event store instead of the samples when `PGHOST` is set:

```sh
kubectl --context k3d-software-factory -n telemetry port-forward svc/otel-collector 4318 &
kubectl --context k3d-software-factory -n factory port-forward svc/postgres 5432 &
```

- The workers can run on the host instead of in the cluster, against forwarded Prometheus, Loki, Tempo and Postgres, and a gateway that runs on the host too. The collector's address is the default (`localhost:4318`, forwarded as above), so the workers' own telemetry arrives as well:

  ```sh
  kubectl --context k3d-software-factory -n telemetry port-forward svc/prometheus-server 9090:80 &
  kubectl --context k3d-software-factory -n telemetry port-forward svc/loki 3100 &
  kubectl --context k3d-software-factory -n telemetry port-forward svc/tempo 3200 &
  export PGHOST=127.0.0.1 PGDATABASE=factory PGUSER=factory_writer \
    PGPASSWORD="$(kubectl --context k3d-software-factory -n factory get secret postgres-writer -o jsonpath='{.data.password}' | base64 -d)"
  # The gateway, with the keys from the Keychain (leave one out to replay that provider only), on :8080. It reaches LM
  # Studio at 127.0.0.1:1234; ALL_LOCAL=true sends every agent there.
  GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/cassettes TYPESAFE_API_KEY="$(security find-generic-password -s typesafe-api-key -w)" \
    ANTHROPIC_API_KEY="$(security find-generic-password -s anthropic-api-key -w)" \
    node --import ./apps/factory/src/telemetry.ts apps/factory/src/cli.ts gateway &
  GATEWAY_URL=http://localhost:8080 ARTIFACTS_DIR=/tmp/artifacts node apps/factory/src/cli.ts triage
  APP_URL=http://website.localhost:8080 ARTIFACTS_DIR=/tmp/artifacts PORT=8090 node apps/factory/src/cli.ts probes run
  ```

  The GitHub worker acts as the factory's App, with its key from the Keychain; `GITHUB_DRY_RUN=true` records what it would do in the artifact store and touches nothing in GitHub:

  ```sh
  GITHUB_APP_CLIENT_ID=Iv23liE1Dj3iYkwWX59z GITHUB_APP_PRIVATE_KEY="$(security find-generic-password -s factory-github-app-key -w | base64 -d)" \
    GITHUB_DRY_RUN=true ARTIFACTS_DIR=/tmp/artifacts PORT=8091 node apps/factory/src/cli.ts github run
  ```

  Scale the cluster's copy of a worker to nothing first (`kubectl -n factory scale deployment/triage --replicas=0`), and back to one after, so two do not take the same signals. Add `PAGES_URL=http://localhost:8090` to triage to have it read the pages reports name.
- Node 24 runs TypeScript directly: erasable syntax only, `.ts` extensions in imports, no build step. The console's browser code is the exception: Vite builds it.
- In the console, anything that runs every frame (a drag, a wipe, the reel settling) writes to the DOM through refs, and React state changes only when the movement ends. A test counts renders during a drag.
- Visual snapshots are taken in the pinned Playwright image, never on the host: `make e2e` refreshes them with `UPDATE=1`.
- Commits and pull request titles are Conventional Commits (`scripts/commit-msg.ts` checks both). Pull requests are squash-merged; nothing is pushed to `main`.
- `deploy/` is GitOps: Argo CD deploys what is on `main`, so a change there reaches the cluster only when it merges. A deploy change that needs a new image (a migration, a new setting) waits for the pull request that pins that image.
- Files listed in `.github/CODEOWNERS` are the rules of the line. Change them only when Martin asks.
- Merging is Martin's call. The factory's App opens the deploy and release pull requests; no workflow opens or approves one.
- pnpm installs no release younger than a day, runs no dependency's install script unless `pnpm-workspace.yaml` allows it, and refuses a provenance downgrade. When it refuses, find out why; an exception goes in that file with its reason.
- Refresh a Dependabot pull request with `@dependabot rebase` or `@dependabot recreate`. Don't close it: that tells Dependabot to skip the version.
- A follow-up with no home yet goes in [`docs/PLAN/BACKLOG.md`](docs/PLAN/BACKLOG.md), not in a code comment.
