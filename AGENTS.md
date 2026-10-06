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
  # Studio at 127.0.0.1:1234; ALL_LOCAL=true sends every agent there. Its cassettes hold whole prompts, reports and
  # tool output: keep them out of the repository (only eval cassettes, made from invented reports, are committed).
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

  Runners need the cluster: their agent pods reach the cluster's gateway and the line's handback, and nothing else. The smoke run asks the line, through a port-forward to its step API, to have a coder fix an off-by-one seeded in a scratch copy of the app; the GitHub worker records the commit it would have made, and nothing reaches GitHub. The coder works on Claude, through the cluster's gateway, and the run costs money; with `ALL_LOCAL=true` on that gateway and LM Studio running, it works on Qwen, for nothing:

  ```sh
  kubectl --context k3d-software-factory -n factory port-forward svc/line 8092:8080 & sleep 2
  curl -s localhost:8092/v1/smoke -H 'content-type: application/json' -d "{\"commit\":\"$(git ls-remote https://github.com/mrogan/cv-worlds-worst-website.git main | cut -f1)\"}"
  ```

  The line itself (`factory line serve`) runs in the cluster only, for the same reason: its agent pods reach its handback there. `LINE_MODE` on its deployment turns it on, `dry-run` to have the GitHub worker record what it would do, and it is a deploy change like any other. The `factory` and `factory-runner` images move together. In `dry-run` the GitHub worker passes the checks on the commits it would have made and merges its pull requests after a while (`GITHUB_DRY_RUN_CHECKS_SECONDS`, `GITHUB_DRY_RUN_MERGE_SECONDS` on its deployment), so the line goes round. For a night on Qwen, set `ALL_LOCAL=true` on both the gateway and the line: the line gives a step on the local model longer. To take one work item end to end, one step at a time on the local model, set `LINE_ONLY` on the line to its number: the line takes that ticket onto it if it is not there, and leaves every other work item as it is. The morning after, with Postgres forwarded as above and `kubectl proxy` running, `KUBE_API_URL=http://127.0.0.1:8001 node apps/factory/src/cli.ts line soak-check --since <when it started>` says whether a lease is stuck, a runner left behind, an event not valid, or a work item spent more than `FACTORY_PROFILE`'s cap on one, with the total spent, and how the work items went round (`--json` for all of it). Add `--no-spend` after a night on Qwen, which must spend nothing at all.

  One agent's step also runs on the host, for working on its prompt, with no cluster but Postgres for its job token (the one forwarded above, or a throwaway container migrated by `packages/store/src/migrate.ts`). `factory line bench <agent> <fixture>` runs the runner's own prepare and agent steps on a fixture's invented work (`apps/factory/src/line/bench/fixtures.ts`), against a gateway on the host, and prints the handback, whether its result fits the agent's schema, how many of its calls the cassettes replayed, and how long it took; alone, it lists the fixtures. Work on Qwen, as here; then without `ALL_LOCAL` and with the Anthropic key, to record Claude's cassettes, which costs money; then with `GATEWAY_MODE=replay`, which replays a step in seconds up to its first changed call. Cassettes made from fixtures hold only invented work and the app's public code:

  ```sh
  ALL_LOCAL=true GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/bench-cassettes PORT=8180 node apps/factory/src/cli.ts gateway &
  GATEWAY_URL=http://localhost:8180 node apps/factory/src/cli.ts line bench coder off-by-one
  ```

  A runner's two steps also run as containers, for working on the runner itself: `docker build -f apps/runner/Dockerfile .`, then `runner prepare` and `runner agent` with the variables in `apps/runner/src/step.ts`.

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
