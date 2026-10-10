---
name: try-the-line
description: Try the line or one agent on the Mac — the bench, the local cluster with unmerged images, a soak, stopping the line or reaching a cap — and undo it all afterwards. Use before changing the local cluster for a run, and when watching or checking one.
---

# Trying the line on the Mac

Three ways in, from smallest: one agent's step on the **bench**, with no cluster; the **smoke run**, a coder in the cluster on a seeded off-by-one; and **the line on the local cluster**, on images built from a branch. The commands for the host's workers, the smoke run and `soak-check` are in the root `AGENTS.md`; this skill adds how to run them safely and leave nothing behind.

The local cluster is `k3d-software-factory`, and it is disposable. Unmerged code is tried there on images built locally, not merged first; merging stays Martin's call. Pushing, opening pull requests and filing issues still need his yes.

The helpers are in `bin/` beside this file: `k` is kubectl on the local cluster, `q` is psql on its store, `poll` and `watch` follow a run, and `trace.js` prints a step's conversation.

## Before you change anything

Copy the checklist at the end into `scratch/` and record each value before you change it: the sync policy, every image, every env variable. Tick each line as you put it back.

To change the cluster in auto mode, Martin may add `Bash(kubectl --context k3d-software-factory *)` to `.claude/settings.local.json`. Without it, ask him.

## The bench: one agent's step, no cluster

`factory line bench <agent> <fixture>` runs the runner's own prepare and agent steps on the host, on a fixture of invented work (`apps/factory/src/line/bench/fixtures.ts`), against a gateway on the host; alone, it lists the fixtures.

1. A throwaway Postgres for the job token and `model_calls`:
   ```sh
   docker run -d --name sf-bench-pg -e POSTGRES_USER=factory -e POSTGRES_PASSWORD=factory -e POSTGRES_DB=factory -p 127.0.0.1:5433:5432 public.ecr.aws/docker/library/postgres:18.6-alpine3.24@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
   DATABASE_URL=postgres://factory:factory@127.0.0.1:5433/factory WRITER_PASSWORD=writer node packages/store/src/migrate.ts
   ```
2. A gateway on Qwen (LM Studio on 127.0.0.1:1234):
   ```sh
   PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=factory PGUSER=factory_writer PGPASSWORD=writer \
     GATEWAY_MODE=replay-record CASSETTES_DIR=/tmp/bench-cassettes ALL_LOCAL=true PORT=8180 OTEL_SDK_DISABLED=true \
     node apps/factory/src/cli.ts gateway &
   ```
   For Claude, drop `ALL_LOCAL` and add `ANTHROPIC_API_KEY="$(security find-generic-password -s anthropic-api-key -w)"`: it costs money. For replay only, `GATEWAY_MODE=replay`.
3. The step: `GATEWAY_URL=http://localhost:8180 PGHOST=127.0.0.1 PGPORT=5433 PGDATABASE=factory PGUSER=factory_writer PGPASSWORD=writer node apps/factory/src/cli.ts line bench coder off-by-one`.

A step run again replays every call. A tool that prints a time the cassette key does not know ends a replay at that call: add a pattern to `UNSTEADY` in `gateway/agent-cassettes.ts`. Only cassettes made from invented work may be committed.

The bench's calls go into its own Postgres, on the same Anthropic key as the cluster: note what a Claude run cost before removing the container.

LM Studio's settings are part of a run. Save them as the model's defaults (My Models, the model's gear), not on the loaded model, which loses them on a reload: Reasoning Effort Medium (the only effort Qwen runs at: the gateway sends it none), Temperature 0.6, Context Length 119,552, Max Concurrent Predictions 1, Preserve Thinking on. `lms ps` and `lms server status` check them.

## The line on the local cluster

The line runs in the cluster only: its agent pods may reach only the gateway and the handback.

1. **Build** `factory` and `factory-runner` from one commit, in a worktree, and import them:
   ```sh
   T=local-$(git rev-parse --short HEAD)
   docker build -f apps/factory/Dockerfile -t ghcr.io/mrogan/cv-software-factory/factory:$T .
   docker build -f apps/runner/Dockerfile -t ghcr.io/mrogan/cv-software-factory/factory-runner:$T .
   k3d image import -c software-factory ghcr.io/mrogan/cv-software-factory/factory:$T ghcr.io/mrogan/cv-software-factory/factory-runner:$T
   ```
   Build `console` too if its code changed.
2. **Pause Argo CD** on `root` only, which owns every factory deployment: `bin/k -n argocd patch application root --type merge -p '{"spec":{"syncPolicy":{"automated":null}}}'`.
3. **Admission:** images built here are unsigned, and admission control refuses them in `factory` and `runners` (ADR 0010). Switch the factory's policy, and only it, to audit: `bin/k patch imagevalidatingpolicy factory-images --type merge -p '{"spec":{"validationActions":["Audit"]}}'`. It covers `factory` and `runners`. Never `website-images`: nothing built on the Mac runs in `website`.
4. **Dry run first**, before anything else can act: `GITHUB_DRY_RUN=true` on `github`, and `LINE_MODE=dry-run` on `line`, with `LINE_TAKE` removed. Optionally `GITHUB_DRY_RUN_CHECKS_SECONDS` and `GITHUB_DRY_RUN_MERGE_SECONDS` to go round faster.
5. **Point** `line` (its container, its `runner-image` initContainer and `RUNNER_IMAGE`), `gateway` and `github` at the new images with `kubectl set image` and `set env`.
6. **Migrations:** compare `select * from schema_migrations` with `packages/store/migrations`; if the branch adds one, run a copy of the `migrate` Job on its console image.
7. **The model:** `ALL_LOCAL=true` on both `gateway` and `line` for Qwen, on neither for Claude. They must match, since the line sets a step's bounds from it. Stop the line before switching, so no step straddles the change.
8. **The work item:** `LINE_ONLY=<number>` on `line`, chosen by the line's own rule (the oldest open ticket of the highest severity not yet on the line), skipping duplicates of a defect already fixed. Never answer a hold in Martin's name to get one moving: take the next ticket instead.

Run one work item at a time: two steps on one LM Studio halve its speed. The dry-run GitHub worker keeps its pull requests in memory, so a restart forgets them and reuses their numbers, issues included. `make stop-the-line` and `make start-the-line` need `KUBECTL="kubectl --context k3d-software-factory"`, and a stopped line also stops triage.

**The smoke run** posts to the line's step API (root `AGENTS.md`) with `"round"`: a job's name, and so its token, is used once, so each smoke run on the same commit needs a new round.

## Stopping the line, and a cap

- **Stop the line** with a step in hand: `make stop-the-line REASON="..."`. Its Jobs should go at once, `runners` empty within a minute, and nothing count against the step; after `make start-the-line` it runs again as a new Job.
- **A release in flight** is aborted by the same command (with none, it says so): the stable version takes all the traffic within seconds, and the script prints the weights and the one command that retries the release. `make start-the-line` does not resume it: an aborted release stays aborted until it is retried, which is Martin's call, or a new deploy starts another. Stopping the line for a run therefore stops a real release of the app too, if one is going out: look first (`bin/k -n website get rollout website`), and tell Martin if you aborted one.
- **A provider's cap.** For the local model, `lms server stop` during a step, then `lms server start`. For Anthropic, Martin sets the Claude Console workspace's limit below its spend, and raises it again after; never change it yourself. The gateway appends `spend.capped` at the first refused call and probes every three minutes until it can append `spend.cleared`. The line should start no step behind the cap, count nothing against the step it ended, and run it again when the cap clears; the console says why meanwhile.

## Following a run

- `bin/watch <after-seq>` streams new events, Job changes and pod restarts, once a minute, for Claude Code's Monitor tool. `bin/poll <after-seq> [since]` is one look: events, `model_calls` by job (calls, minutes, prompt size, cache reuse, cost), the line table and runner Jobs.
- **`factory line soak-check`** from the host, as root `AGENTS.md` shows, with `kubectl proxy` and Postgres forwarded. Never by `kubectl exec` in the line pod: a second Node process there passes its memory limit and restarts the line. `--no-spend` after a run on Qwen.
- **A step's conversation.** In `record` mode the gateway keeps every call as a cassette on the `cassettes` volume, and the last call's request holds the conversation so far; `model_calls.cassette` is its hash. The gateway's image has no shell: start a short-lived pod on the `factory` image with the volume read-only at `/c`, `args: [-e, "setTimeout(()=>{}, 3600e3)"]` (the entrypoint is node), as user 65532 with a read-only root and no capabilities, then `bin/k -n factory exec -i <pod> -- /nodejs/bin/node - <hash prefix> < bin/trace.js`. Delete the pod after.
- **Runner Job names** are `<agent>-<work item>-<round>-<n>`, where `n` counts every step the work item has started, whichever agent.

## Putting it back

Order matters. Giving `root` its sync policy back restores images and the values `main` sets, but not env variables that `main` does not set: with `LINE_ONLY` left behind and `LINE_MODE` restored to `live`, the line would act in GitHub on that work item. And a line in dry run with neither `LINE_ONLY` nor `LINE_TAKE` takes the next ticket at once, which a live line then carries to its end, with the dry run's made-up issue. So first set `LINE_MODE=off` on `line`, which takes nothing; then remove the added env; then delete any runner Jobs left in `runners` (`bin/k -n runners delete jobs --all`), or wait until there are none, since `root` puts `factory-images` back to Deny before it moves the deployments off the local images, and a Job on one would be refused; then restore the sync policy, which sets `LINE_MODE` back and puts `factory-images` back as `main` says; then check each deployment's env against what you recorded, that `bin/k get imagevalidatingpolicy -o custom-columns=NAME:.metadata.name,ACTIONS:.spec.validationActions` shows both policies as `main` sets them (`factory-images` `[Deny]`; `website-images` `[Audit]` until the app's first signed release, `[Deny]` after), that no pod or Job in `factory` or `runners` still runs a local image (`bin/k -n factory get pods,jobs -o jsonpath='{..image}'`, and the same for `runners`, with nothing `local-`: a pod admitted under Audit keeps running after Deny returns), and that `select work_item, stage from line` has nothing new.

Copy this into `scratch/` at the start:

```markdown
# To undo after <the run>

- [ ] `line`: `LINE_MODE=off` first, so it takes nothing while the rest comes off.
- [ ] `line` env: remove `LINE_ONLY`, `ALL_LOCAL` and anything else added; was: …
- [ ] `gateway` env: remove `ALL_LOCAL`; was: …
- [ ] `github` env: remove `GITHUB_DRY_RUN_CHECKS_SECONDS`, `GITHUB_DRY_RUN_MERGE_SECONDS`; was: …
- [ ] `runners`: no Jobs left before `root` gets its sync policy back.
- [ ] `factory-images`: back as `main` sets it, which `root`'s self-heal does; was: …
- [ ] No pod or Job in `factory` or `runners` on a `local-` image.
- [ ] Argo CD `root`: `{"automated":{"prune":true,"selfHeal":true}}`, then check `line`, `gateway` and `github` are back on `main`'s images (`line`'s container, `runner-image` and `RUNNER_IMAGE`), with `LINE_MODE`, `LINE_TAKE` and `GITHUB_DRY_RUN` as `main` sets them, and no work item new on the line; was: …
- [ ] Any copied `migrate` Job deleted (migrations stay applied).
- [ ] Local images removed: `docker rmi` each `local-*` tag.
- [ ] The line started (`make start-the-line`), so triage takes work again.
- [ ] LM Studio's server running (`lms server status`).
- [ ] The Claude Console workspace's limit back where it was, if Martin lowered it.
- [ ] The bench's Postgres removed (`docker rm -f sf-bench-pg`), its Claude spend noted.
- [ ] Anything outward made for the run (a label, pull requests made to try a gate) listed for Martin.
- [ ] The store: the dry run's events stay on the work items it took, with its made-up pull request and issue numbers. Say which, for Martin to keep or clear.
```
