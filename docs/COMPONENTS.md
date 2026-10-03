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
| **Orchestrator** | Work queue, state, retries, concurrency, stop the line | Postgres-backed queue and TypeScript workers | Temporal, AWS Step Functions |
| **Event store** | Append-only record of every step, with captured artifacts (spec 5.1) | Postgres table; artifacts in object storage (local disk, Spaces or S3 by profile) | |
| **LLM gateway** | Credentials, budgets, logging, redaction, model routing; live, record and replay modes (spec 7.1) | In-house TypeScript proxy with Anthropic (or Bedrock on `aws` via EKS Pod Identity) and TypeSafe adapters | LiteLLM behind the same interface |
| **Agent runners** | One disposable sandbox per task, with repo checkout and toolchain | Kubernetes Jobs; no secrets mounted; NetworkPolicy allows only GitHub, the gateway and the package mirror | gVisor or Firecracker isolation |
| **Factory GitHub App** | The factory's identity in GitHub | Short-lived installation tokens (permissions below) | |
| **Scoreboard** | Matches tickets to answer-key fingerprints | Separate service; the only component that can read the answer key | |
| **Defect injector** | Opens regression PRs from the private catalogue | Job triggered by Martin, schedule or visitor menu | |
| **Red-team harness** | Runs curated attacks against real mechanisms and records the refusals | Job that launches an adversarial agent or scripted action per attack | |
| **Console** | The UI for visitors and admin (spec 5) | React 19 single-page app built by Vite 8 (ADR 0007), served by a Node server that relays the event store live over server-sent events; the same build, fed from files, is the replay site | |
| **Visitor access** | Keys, usage tracking, rate limits, visitor budget (spec 5.6) | Part of the console backend; keys in Postgres | |

### Factory GitHub App permissions

- **Allowed:** contents (branches), pull requests, checks, issues.
- **Denied:** workflows, administration, bypassing rulesets.

## Agents

| Agent | Reads | Produces | Constraints |
|---|---|---|---|
| **Triage** | Probe, crawler, telemetry and canary signals; user reports | Deduplicated, classified tickets with evidence | Jev question set plus routing code, not a generative agent; quarantines injection attempts; parks suggestions for Martin |
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
| **Telemetry** | Metrics, logs, traces and SLOs | OpenTelemetry SDK and collector → Prometheus, Loki, Tempo, Grafana, all over OTLP; upstream charts at pinned versions | CloudWatch on `aws` |
| **Probes and crawler** | Synthetic journeys and site checks; screenshots for the event store, with the checked elements' positions, and each page compared with the version before | Playwright on a schedule; same journeys as CI e2e | |
| **The app** | The World's Worst Website (spec 3) | TypeScript on Node, pages rendered on the server, no framework. Catalogue in SQLite (`node:sqlite`), built into the image and read-only. Baseline and canary side by side, each with its own data | |

## What changes per profile

| | `local` | `demo` | `pages` | `do` | `aws` |
|---|---|---|---|---|---|
| Cluster | k3d | k3d | none | DOKS, one node | EKS |
| Models | Anthropic API and Jev, or replay | Replay only | none | Anthropic API and Jev | Bedrock and Jev |
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
