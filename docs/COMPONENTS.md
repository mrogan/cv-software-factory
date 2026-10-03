# Software Factory: components

The parts of the factory, how they connect, and what each one is built with in v1. The specification says *what* the factory must do; this document says *which part does it*. Where they differ, the specification wins.

Each component lists its v1 choice and, where useful, what it might grow into. Later choices are ideas, not commitments.

## Planes

| Plane | Job | Rule |
|---|---|---|
| **GitHub** | Source of truth and deterministic gates | No model judgement decides anything here |
| **Factory** | Where agents think, and the console | The only plane with model access |
| **Runtime** | Runs the app, telemetry and delivery tooling | Pulls from git; nothing pushes to it |
| **Private** | The correct app, defect patches, answer key, injector catalogue, environment settings | Never reachable by agents |

## Factory plane

| Component | Purpose | v1 | Later |
|---|---|---|---|
| **Orchestrator** | Work queue, state, retries, concurrency, stop the line | Postgres-backed queue and TypeScript workers. Its first part is the inbox: senses insert signals, and triage takes each once with `for update skip locked` under a lease, woken by `NOTIFY`, with a limit on attempts. Every worker checks for `line.stopped` before it takes work; `make stop-the-line` appends it | Temporal, AWS Step Functions |
| **Event store** | Append-only record of every step, with captured artifacts (spec 5.1) | One Postgres table (`packages/store`), with numbered migrations that a hook Job applies before the console starts. A trigger refuses every update, delete and truncate; appends commit in `seq` order and notify listeners. An event appended again with the same `id` and content is stored once, so a worker can retry; the same `id` with different content is refused. The store records once whether it holds samples or real events, and numbers real work items from 1000. Two roles: the factory's writer appends and reads, the console's reader sees public views only. Event types, their Zod schemas, public views and upcasters are `packages/events`. Artifacts are files named by the SHA-256 of their contents (local disk on a volume; Spaces or S3 by profile) | Snapshots or paged history, if the event count grows |
| **LLM gateway** | Credentials, budgets, logging, redaction, model routing; live, record and replay modes (spec 7.1) | `apps/factory/src/gateway`: a TypeScript service in the `factory` namespace, run by `factory gateway`. `POST /v1/judgements` takes an agent, a work item, a question set, a pinned model, the state and the questions, and returns the answers with their cost and cassette key. It holds the TypeSafe key, calls Jev with `fetch` (a timeout; retries with backoff, honouring `Retry-After`) and checks every response with Zod. It never logs a state or a provider's body. Modes are live, record, replay and replay-record, and with no key it replays only. A cassette is a file named by the SHA-256 of the provider, model, questions and state. One cap across every provider (`policy/spend.ts`) is counted from the `model_calls` table, the audit log of every call: at a day or month cap the gateway refuses and appends `spend.capped` to the line, and `spend.cleared` when the window ends; each work item has a cap of its own. Metrics for calls, spend and latency over OpenTelemetry. The Anthropic adapter (or Bedrock on `aws` via EKS Pod Identity) joins it behind the same interface with the planner | LiteLLM behind the same interface |
| **Agent runners** | One disposable sandbox per task, with repo checkout and toolchain | Kubernetes Jobs; no secrets mounted; NetworkPolicy allows only GitHub, the gateway and the package mirror | gVisor or Firecracker isolation |
| **Factory GitHub App** | The factory's identity in GitHub | Short-lived installation tokens (permissions below) | |
| **Scoreboard** | Matches tickets to answer-key fingerprints | Separate service; the only component that can read the answer key | |
| **Defect injector** | Opens regression PRs from the private catalogue | Job triggered by Martin, schedule or visitor menu | |
| **Red-team harness** | Runs curated attacks against real mechanisms and records the refusals | Job that launches an adversarial agent or scripted action per attack | |
| **Console** | The UI for visitors and admin (spec 5) | React 19 single-page app built by Vite 8 (ADR 0007) in its own image stage. The Node server serves the build by Vite's manifest, the public events as JSON and as server-sent events resuming from `Last-Event-ID`, and the artifacts public events refer to. The browser projects: `project(events, t)` is plain TypeScript, so live and replay are the same code; the same build, fed from an event-log folder, is the replay site | |
| **Workers and images** | Where the gateway, triage, the intake, the log watcher, the probes and the crawler run | One Deployment each in `factory` (`deploy/base/factory`), one replica, writing to the event store as the factory's writer and to the artifacts volume (which the console still mounts read-only). Two images, built by `build.yml` and pinned by digest per profile in a pull request it opens (ADR 0005): `factory`, distroless Node, for the gateway, triage, the intake and the log watcher; `factory-browser`, from the pinned Playwright image, running as an unprivileged user, for the probes and the crawler. Chromium runs without its own sandbox, which the restricted Pod Security Standard refuses it, so the pod's other fences carry that. The gateway's cassettes are on a volume only it mounts, so recordings of real reports stay in the cluster. `make up` creates its Secret from `TYPESAFE_API_KEY` or the Keychain, through stdin and no file; with none it replays only | Spaces or S3 for artifacts, a cloud secret store for the key |
| **Network policies** | Only the gateway may leave the cluster | In `factory`, everything is denied in and out, then each pod is allowed what it needs: DNS, Postgres and the collector for the workers; Prometheus, Loki and Tempo for the intake and log watcher; the app for the probes and crawler; the gateway for triage; Alertmanager for the intake. The gateway alone may reach the internet, on port 443, outside the cluster's own addresses. k3s enforces them. `make egress` starts a pod labelled like a worker and shows it reaches nothing, while the gateway reaches TypeSafe | |
| **Factory command** | `factory events load`, `play` and `export`, `factory probes` and `factory crawler` (spec 5.6 names the command) | `apps/factory`: moves event-log folders in and out of the store, refusing to mix samples with real events; its capture step (Playwright: a screenshot and where the probe looked) is how the probes keep evidence; `factory probes run` runs the probes, and `factory probes once` prints what each check finds without writing to the inbox | Keys, and the workers' entry points |
| **Samples** | What the console shows until the factory does real work | Twelve hand-written work items (`packages/samples`), typed against the events, with real screenshots of the app with each sample's change made in a scratch copy; exported as an event log that `make check` keeps current, and checked against the answer key in the private repository | Replaced by real events from milestone 4 |
| **Visitor access** | Keys, usage tracking, rate limits, visitor budget (spec 5.6) | Part of the console backend; keys in Postgres | |

### Factory GitHub App permissions

- **Allowed:** contents (branches), pull requests, checks, issues.
- **Denied:** workflows, administration, bypassing rulesets.

## Agents

| Agent | Reads | Produces | Constraints |
|---|---|---|---|
| **Triage** | Probe, crawler, telemetry and canary signals; user reports | Deduplicated, classified tickets with evidence | `packages/triage`, run by `factory triage`. A sense's signal takes its category and severity from `policy/triage.ts` and repeats by fingerprint; only reports go to Jev (`triage/v1`), with routing as plain code. Quarantines injection attempts; parks suggestions for Martin; one fingerprint, one ticket |
| **Planner** | Tickets; Martin's improvement requests | A spec per ticket: outcome, acceptance criteria, scope, risk, rollout | Rejects or escalates anything it cannot make testable |
| **Coder** | Planner spec, repo | Failing test, fix, PR | Stays in scope; cannot sign, merge or touch workflows |
| **Reviewer** | PR diff and spec, once gates pass | Review as a check run | Extra signal only; escalates risk to "Needs you" |

## GitHub plane

| Component | Purpose | v1 | Later |
|---|---|---|---|
| **Repositories and rulesets** | Single path for change | PR-only `main`, squash merges, required checks, linear and signed history, CODEOWNERS on workflows, policy and test config; Actions pinned by SHA. Applied to both public repositories by `scripts/github-settings.ts` | |
| **Shared gates** | One rule for both public repositories, out of the app repository's reach | The title check, CodeQL and Scorecard are reusable workflows here, called from the app's repository at a pinned commit | |
| **Approval routing** | Sends risky changes to a human | Risk tags: test loosening, dependency change, security headers, out-of-scope files. Behaviour depends on autonomy level (spec 4.3) | |
| **CI pipeline** | Deterministic gates (spec 4.1) | GitHub Actions on GitHub-hosted runners. Target under 3 minutes: lint, format, type-check, unit, integration, e2e journeys against a throwaway k3d cluster in the runner, axe on changed pages, secrets scan | Visual regression, performance budgets, DAST, load tests |
| **Test integrity** | Stops agents weakening tests to get green | Flags deleted or edited tests, falling assertion counts, and acceptance criteria without a tagged test | Mutation score on changed code (Stryker) |
| **Security scanning** | Code, dependencies, images, secrets | CodeQL, Dependabot, Trivy, GitHub secret scanning | Semgrep, licence checks |
| **Supply chain** | Only the pipeline can produce deployable images | Keyless cosign signing via GitHub OIDC; SBOM with Syft | SLSA provenance, policy gate with conftest |

## Runtime plane

| Component | Purpose | v1 | Later |
|---|---|---|---|
| **Ingress** | Public entry to `do` and `aws` | Cloudflare Tunnel: no load balancer, no open ports | |
| **Registry** | Signed images, referenced by digest | GHCR, shared by every profile | ECR on `aws` |
| **GitOps** | Cluster state reconciled from git | Argo CD app of apps, one Kustomize overlay per profile. Each overlay pins image digests; CI opens a pull request to move them. The app deploys from its own repository through its own Argo CD project: a few namespaced kinds, in the `website` namespace, and nothing else | Promotion pull requests from the factory's GitHub App |
| **Admission control** | Refuses unsigned images | Kyverno image verification | |
| **Progressive delivery** | Canary against baseline; automatic promote or roll back | Argo Rollouts with short steps (for example 20% then 100%), analysed on error rate, latency and probe results | More steps, business metrics |
| **Traffic generator** | Gives canary analysis enough samples within minutes | Small load job hitting key journeys | |
| **Feature flags** | Ship improvements switched off; kill switch without rollback | OpenFeature with flagd | |
| **Telemetry** | Metrics, logs, traces and SLOs | OpenTelemetry SDK and collector → Prometheus, Loki, Tempo, Grafana, all over OTLP; upstream charts at pinned versions. Grafana has a dashboard for the app, one for the console and one for the factory: inbox depth, signals by sense, time from signal to ticket, and gateway spend. The app's request metrics carry `http_route` (the path asked for, such as `/products/glove-left`), the status and `service_version`; its request log records carry `route` (the template, `/products/:slug`), `path`, `status`, `ms` and the trace id | CloudWatch on `aws` |
| **Alerting** | The app's objectives, watched by the standard tools | `policy/objectives.ts` holds one error-ratio and one latency objective, applied to every route alike over a short window, and judged only for a route with a minimum number of requests. `apps/factory/src/alerts/rules.ts` generates Prometheus's alerting rules from it into `deploy/base/telemetry/values/prometheus-rules.yaml`, labelled with the route and the symptom class (`server-error`, `slow-response`); `make check` fails when the file is out of date. Alertmanager has one receiver, a webhook to the intake. The intake (`factory intake`) answers `POST /v1/alerts`: each firing alert becomes a `metrics` signal with the series behind it as a metric picture, the app's version, and the route as the app's log names it; a resolved alert writes nothing | |
| **Log watcher** | The app's logs, read for what a query cannot say (`factory logs`) | Three checks, each with its own cursor, reading Loki. **New error patterns:** error records reduced to a pattern (numbers, identifiers, hashes, quoted values and the request's own path taken out, the exception the record attaches kept) and signalled by route when the previous day has not shown them, with the lines and trace ids, and the spans when Tempo already has the trace. **Reports:** each record of the widget becomes a `report` signal; the text goes to the inbox and to no log line, metric label or error message. **Agreement:** per route, the requests counted in metrics, logged and traced over two windows that ended minutes ago (Tempo answers late); the odd one out is `missing-log` or `wrong-metric`. Signals count as `factory_signals_total{sense}` | |
| **Probes and crawler** | Synthetic journeys and site checks; screenshots for the event store, with the checked elements' positions, and each page compared with the version before | Playwright on a schedule. The probes (`apps/factory/src/probes`) are the journeys a shopper takes (browse, open a product, search, page through the catalogue, send the contact form), each made of generic checks compared with the app's own API where it has one, and written from its public pages without the answer key. A sense runner (`apps/factory/src/senses`) runs them every few minutes and at once when `/version` changes, and sends a signal only for a check that has failed twice in a row, with a screenshot and the evidence. A check that costs something, such as sending a contact message, may run at most so often (the contact checks, once an hour). `factory probes run` also serves a page reader for triage (`POST /v1/pages` with a path: a screenshot in the artifact store, and the page's text in passages). The crawler (`apps/factory/src/crawler`, `factory crawler run`) follows every link, image, script and stylesheet from the home page on the same origin, up to a cap, and checks each page and asset: broken links and images, redirect loops, server errors, console errors, accessibility with axe (only the rules that name a class: missing alt text, contrast, unlabelled fields), the usual security headers, caching of static assets, response time, and whether the error pages for a missing page and a malformed request give away stack traces, paths or software versions. It uses the same runner, so a check signals after failing twice in a row. A finding is on the route template worked out from the URLs it saw (`/products/:slug`), and a class found on every page crawled is one finding for `*`. Each probe is tested against a small shop made in the test, with and without its fault; those tests run in the pinned Playwright image | |
| **The app** | The World's Worst Website (spec 3) | TypeScript on Node, pages rendered on the server, no framework. Catalogue in SQLite (`node:sqlite`), built into the image and read-only. Baseline and canary side by side, each with its own data | |

## What changes per profile

| | `local` | `demo` | `pages` | `do` | `aws` |
|---|---|---|---|---|---|
| Cluster | k3d | k3d | none | DOKS, one node | EKS |
| Models | Anthropic API and Jev, or replay | Replay only | none | Anthropic API and Jev | Bedrock and Jev |
| Model spend cap, across every provider | $20 a day | none: replay costs nothing | none | $20 a day, $100 a month | $20 a day, $100 a month |
| Artifacts | Local disk | Local disk | Bundled files | Spaces | S3 |
| Visitor actions | Off | Off | Off | On | On |

## Guardrails and what enforces them

The guardrails are defined in spec section 6. This table shows which component holds each one.

| # | Guardrail | Enforced by |
|---|---|---|
| 1 | Agents cannot change the rules | GitHub App has no workflows permission; rulesets and CODEOWNERS |
| 2 | Gates are deterministic | Required checks on the ruleset; reviewer agent is a non-required check |
| 3 | Only the pipeline builds releasable artifacts | cosign signing via OIDC; Kyverno admission control (also a red-team attack) |
| 4 | No agent writes to production | Argo CD pulls from git; runners have no cluster credentials; telemetry access is read-only |
| 5 | Sandboxes are disposable and fenced | Kubernetes Jobs; NetworkPolicy egress allowlist; no secrets mounted |
| 6 | One gateway for all model access | Only the gateway holds model credentials |
| 7 | Hard spend caps | Gateway budgets per day, month, task and visitor, across every provider |
| 8 | Inputs are untrusted | Typed Jev answers in triage; gates, scope fences and approval routing, not prompts |
| 9 | Everything is reversible | Argo Rollouts; orchestrator stop-the-line switch |
| 10 | Public means hostile | Factory acts only on its own or Martin-labelled issues; `pull_request` only; GitHub-hosted runners |
