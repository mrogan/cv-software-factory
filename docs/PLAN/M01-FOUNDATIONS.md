# Milestone 1: Foundations

## Outcome

The `cv-software-factory` repo is public, tidy and green. On a fresh clone, `make up` creates a local Kubernetes cluster where Argo CD deploys the telemetry stack, Postgres and a console skeleton built by CI. The skeleton's traces, metrics and logs appear in Grafana.

Nothing clever happens yet. This milestone proves the delivery path and sets the standard for every later commit.

## Decisions

- Repos under the `mrogan` GitHub account: `cv-software-factory` (public from day one), `cv-software-factory-private`, and later `cv-worlds-worst-website`. MIT licence.
- OrbStack is the container runtime.

## Tasks

### 1. Repo and hygiene baseline

- `git init` in the project root; this folder becomes `cv-software-factory`. Create it with `gh repo create mrogan/cv-software-factory --public`.
- `.gitignore` covering `node_modules`, build output, `.env*`, `.DS_Store`, `.obsidian/` and `.claude/settings.local.json`; `.editorconfig`.
- `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md` (the factory does most of the work; how outside contributions are handled), `CODEOWNERS`, issue and PR templates.
- A short, honest README for a hiring manager: what this is and why (from `INTENT.md`), that it is under construction, and links to the intent and the spec.
- Create `cv-software-factory-private` as a private repo with a README only.

### 2. Toolchain

- `mise.toml` pinning Node LTS (24, which runs TypeScript directly), pnpm, kubectl, k3d, helm and kustomize, so one command installs everything.
- pnpm workspace; strict TypeScript base config; Biome for lint and format; Vitest.
- lefthook pre-commit (format, lint, type-check on staged files) and a Conventional Commits check.
- A dev container that gives the same toolchain.
- Nothing outside the stack: the design system's `build.ts` runs on Node like everything else.

### 3. Console skeleton

`apps/console`: a minimal TypeScript web server that serves one page, plus `/health` and `/version` (returning the commit SHA). It is instrumented with the OpenTelemetry SDK. It is the real console's starting point, not a throwaway.

Even the skeleton meets the console's bar: the page is titled "Software Factory · Martin Rogan", uses the design system's `tokens.css` and the mark, self-hosts its fonts, and says in one line what is coming. It is the first thing anyone will see running.

### 4. Makefile

`help` (default), `up`, `down`, `check`, `status`. `check` also rebuilds the design tokens and fails if `tokens.css` is out of date or a colour pair drops below its contrast threshold. Add targets only when they work; `demo` and `stop-the-line` arrive in later milestones.

### 5. CI

- `check` workflow on `pull_request`: lint, type-check, test.
- `build` workflow on `main`: build the console image, push to GHCR by digest, tagged with the commit SHA. Make the package public, so every cluster pulls it without a credential.
- CodeQL, Scorecard on a schedule, Dependabot (npm, Actions, Docker), release-please.
- Every Action pinned to a full SHA; minimal `permissions` in every workflow; `pull_request`, never `pull_request_target`.

### 6. GitHub settings

Applied by a script in the repo, so they are reproducible and reviewable: ruleset on `main` (PRs only, required checks, linear history, no force-push), secret scanning with push protection, private vulnerability reporting, and approval required for first-time contributors' workflows.

`CODEOWNERS` names Martin for `.github/`, `deploy/` and policy files from the start, but the ruleset does not yet require an approving review. GitHub never counts an author's own approval, and until the factory has its own identity every PR is Martin's. Code-owner review is switched on in milestone 5, when the factory's GitHub App starts opening PRs and Martin reviews them. The README says so, so the gap is stated rather than hidden.

### 7. Local cluster and GitOps

- `make up`: create the k3d cluster, install Argo CD with Helm, then apply one root Application pointing at `deploy/overlays/local` on `main`.
- Argo CD then installs everything else: the OpenTelemetry collector, Prometheus, Loki, Tempo and Grafana (the same charts as the cloud profiles), Postgres (a plain StatefulSet) and the console skeleton from GHCR.
- `make down` deletes the cluster and nothing else remains.
- The inner development loop does not wait on GitOps: `pnpm dev` runs services on the host and reaches cluster Postgres and the collector through port-forwards.

### 8. Documentation

Update the spec, `COMPONENTS.md` and `docs/AGENTS.md` wherever reality differs. Write an ADR only if a major decision changes.

## Exit criteria

- [x] `cv-software-factory` is on GitHub with every hygiene item in spec section 9 that applies at this stage; CI is green; the ruleset blocks a direct push to `main`.
- [x] On a fresh clone, `mise install && make up` gives a running cluster in under 10 minutes; `make check` passes; `make down` leaves nothing behind.
- [x] The console skeleton is running in the cluster from a CI-built GHCR image, and `/version` shows the commit it was built from.
- [x] Its traces, metrics and logs are visible in Grafana.
- [x] The first Scorecard result is recorded (no target yet).

## Results

- **Fresh clone to a running cluster:** about four minutes on an M-series laptop with OrbStack, most of it image pulls.
- **First Scorecard: 6.7** (30 September 2026, commit `b0243b0`). The zeros belong to a repository a few hours old: Code-Review (every pull request is Martin's until the factory's GitHub App arrives in milestone 5), Maintained (under 90 days old), CII-Best-Practices, Fuzzing and Contributors. Security-Policy and Branch-Protection score 4 and are worth raising. Signed-Releases waits for image signing in milestone 6.
- **Learned:** pull requests that workflows open run their checks only after a person approves the runs, and only those runs satisfy the ruleset's required checks. The deploy commit goes through GitHub's API so that GitHub signs it, because `main` accepts only signed commits.

## Out of scope

The app, the event schema, agents, the GitHub App, image signing and admission control, and any cloud resources.

## Risks

- **GitOps slows development.** Argo CD only sees pushed commits. Keep the inner loop on the host and use the cluster for integration.
