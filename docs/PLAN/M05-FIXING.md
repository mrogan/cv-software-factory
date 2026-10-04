# Milestone 5: Fixing

## Outcome

The factory fixes. A ticket from milestone 4 goes to the planner, which writes a testable spec; a coder in a disposable sandbox writes the failing test and the fix; the gates in the app's repository judge it; a reviewer agent reviews it and sends it back until it is right; and Martin merges it. Nobody writes a line of the fix, and the console shows every step.

The factory gets an identity in GitHub, its own App, and becomes the only thing that opens pull requests: its fixes, and the deploy and release pull requests that workflows open today. Code-owner review is required on `main` in both public repositories, so every one of those pull requests waits for Martin.

Nothing is canaried or verified yet (milestone 6). A merged fix is deployed the way everything is today, by Martin merging its deploy pull request, and its ticket stays open until verify arrives.

The milestone is built in two parts, each by its own implementing session, because one context cannot hold all of it:

- **Part A, the factory's hands:** the App and the worker that holds its key, the rulesets, the app's gates, the gateway speaking Anthropic's API, and the runners. Everything an agent needs, proved without an agent's judgement in it.
- **Part B, the agents:** the planner, the coder, the reviewer and the describer, the stages that join them, the console, and the fix.

Part B starts when Part A's exit criteria are met and its pull requests are merged. Part A leaves `COMPONENTS.md` and `AGENTS.md` describing what it built, so Part B starts from this file, those two and the code, and needs nothing from Part A's session.

## Decisions

### Identity and the rules

- **One GitHub App is the factory's identity, and one worker holds its key.** `factory github` is the only pod with the App's private key, as the gateway is the only pod with a model key. It makes installation tokens when it needs them, and does everything the factory does in GitHub: commits, pull requests, reviews, issues, and reading check runs and merges. The App may write contents, pull requests, checks and issues; it may not touch workflows or administration, or bypass a ruleset.
- **The factory polls GitHub; GitHub does not call the factory.** The local cluster has no public address, and a webhook receiver would be the first thing on it that the internet could reach. Polling with conditional requests costs nothing against the rate limit when nothing has changed, and a minute's delay is nothing next to a CI run.
- **The factory opens the deploy and release pull requests.** The GitHub worker sees a new image in GHCR built from `main`, or a release due, and opens the pull request as the App, in both repositories. No workflow holds the App's key or any token that can open or approve a pull request; `scripts/github-settings.ts` takes that right away from workflows. Pull requests the App opens run their checks at once, so Martin no longer approves held check runs. ADR 0005 is amended in place.
- **Code-owner review is required on `main`, and Martin's own pull requests pass it by a bypass for the repository admin.** Nobody can approve their own pull request on GitHub, and every human pull request is Martin's; a second account or the App approving for him would be theatre, and dropping the rule would leave the factory's pull requests unguarded. The ruleset splits in two: one holds review (code-owner review, one approval, approval after the last push), with the admin bypass for pull requests only; the other holds everything else (signed and linear history, required checks, squash only) and nobody bypasses it. So Martin's changes still go through a pull request and its checks, and the merge records the bypass. ADR 0009.
- **The factory keeps its own pull requests current.** `main` requires a branch to be up to date, so each merge leaves other pull requests behind. The GitHub worker updates the App's pull requests when they fall behind, before they are ready for review, so an update never makes Martin's approval stale.

### Agents and their sandboxes

- **Claude does the agent work; a local model runs the unattended passes.** Development runs the agents on Claude through the gateway, with an API key billed per token: Anthropic's terms allow no product built on the Agent SDK to use a subscription login. A soak of the whole line overnight, or a regression pass after a change to the runner, tests the plumbing, not the agents, and runs on Qwen 27B in LM Studio on Martin's Mac at no cost. Jev stays for triage.
- **Every agent runs in a runner, on the Agent SDK.** A runner is a Kubernetes Job in the `runners` namespace, for one step of one work item. It runs in two pods, because a NetworkPolicy fences a pod, not a container: a prepare pod, which may reach GitHub and the npm registry, checks out the base commit and installs its dependencies onto the job's volume; then the agent pod, which reaches the gateway and the handback and nothing else, works there. No credential is mounted. The agent pod holds a job token that the gateway and the handback accept for that work item and that agent only, until the job ends.
- **The coder hands back a patch.** At the end of its step the agent pod sends its result to the line worker's handback endpoint: a patch, and a short note of the decisions it made. The patch is data. The line worker checks its size and its paths against the spec's scope, the GitHub worker applies it to a fresh checkout of the base commit outside the sandbox, and commits it through GitHub's API, which signs it, as the App. Nothing outside the sandbox runs git in the sandbox's working tree, where a planted hook or config would run with the worker's rights. ADR 0008.
- **Rules live where the reader who needs them will look:**

  | Kind | Example | Home | Who reads it |
  |---|---|---|---|
  | Invariant: breaking it makes the change wrong or unsafe | interpolate only through `html`; copy in Gerald's voice; a change comes with its test | the repository's `AGENTS.md`, kept short | the coder, always |
  | Mechanical: a tool can check it | formatting, types, lint rules | Biome, `tsc` and the tests, as gates | the coder, only when a check fails |
  | Judgement: taste and design | deep modules, test at the seams, collaborators passed in | `docs/REVIEWERS.md`, not linked from `AGENTS.md` | the reviewer |

  So the coder does not apply coding standards or design rules: they would compete with the work for its context. The reviewer applies them, and its findings go back to the coder, which knows the implementation best. The factory owns how to review (the reviewer's prompt and output schema); each repository owns what to review against, in five short rulings Martin owns, each pointing to code that shows it.
- **The reviewer reviews the diff against the base's rules.** It reads `docs/REVIEWERS.md` from the base commit, so a pull request cannot loosen the rules it is reviewed by. It asks for nothing outside the ticket's scope: the shop is bad on purpose, and a coder that fixed other seeded defects in passing would muddle the scoreboard.
- **Review is a loop with a limit.** Once the gates pass, the reviewer posts a review through the App: each finding anchored to a line, marked blocking or a suggestion, and citing its rule's number. Blocking findings go back to the coder, which resumes its own session (the Agent SDK resumes sessions, and the cached prefix makes that cheap), hands back a new patch, and the gates and the reviewer run again. After two rounds, anything still blocking holds the work item for Martin. The review is a comment review and a check run that is not required: it is a signal, never a gate, and it never blocks a merge in GitHub's rules.
- **Describing is a step of its own.** Once review has settled, a describer with a fresh context writes the pull request's description from the ticket, the spec, the final diff, the review thread and the coder's note, because the coder's context is full of dead ends. Descriptions fit the change: one that needs a line gets a line; one that needs a diagram gets one. It starts from [visual-pr](https://github.com/humanlayer/skills/tree/main/plugins/visual-pr/skills/visual-pr) (MIT), vendored at a pinned commit, changed to write the description to a file and to drop its fixed headings. The spec's pull request template and the templates in both repositories become guidance rather than headings to fill. The same step writes the work item's summary paragraph for the sheet.
- **A runner names its skill.** Claude Code and the Agent SDK put each skill's description in the system prompt and load the rest when it is used. A runner knows which step it is running, so its prompt names the skill rather than leaving the model to choose.
- **Tests come first, and a check says so.** The coder writes the failing test before the fix. A gate runs the pull request's new and changed tests against the base's source, and reports which of them fail there. A fix whose tests all pass on the base holds for Martin.

### Models and spend

- **The gateway speaks Anthropic's Messages API.** A runner's Agent SDK points `ANTHROPIC_BASE_URL` at the gateway, with its job token as the key. Behind the endpoint are providers: Anthropic now, LM Studio on `local` (no key, priced at nothing, still audited and capped), Bedrock in milestone 11. Prompt caching passes through untouched. The provider is part of a cassette's key, so a local recording never stands in for Claude's.
- **A cassette for an agent call leaves out what changes between identical runs.** Two runs of the same agent send requests that differ only in the request's metadata (a session id) and the date in the system prompt; the cassette key leaves both out, and runners use a fixed working directory. Replay falls through to record at the first request that differs, so a changed step pays only from there on. Tool output that varies between runs, such as a test's timings, still ends a replay at that step.
- **Which model each agent uses is policy.** `policy/models.ts` gives each agent, per profile, a provider, a pinned model and its effort, and on `local` a switch that sends every agent to the local model for unattended runs. To start:

  | Agent | Model | Effort |
  |---|---|---|
  | Planner | Sonnet 5.5 | medium |
  | Coder | Sonnet 5.5 | medium |
  | Reviewer | Sonnet 5.5 | medium: high flags more minor findings, and each one is work for the coder |
  | Describer | Sonnet 5.5 | low; Haiku 4.5 measured against it |

  Opus 5.5 only where a measurement shows it helps.
- **Each step is bounded.** A turn limit and a deadline per runner, one work item in Plan, Build and Review at a time, and the per-work-item spend cap. A work item that reaches its cap holds for Martin.
- **The per-work-item cap is measured, not guessed.** The $2 in `policy/spend.ts` predates any agent. A fix priced from the local experiment comes to roughly $0.50 to $2.50 of coder time alone, so `local` runs at $5 per work item while the cost is measured, and the measured figure sets the cap for every profile at the end of Part B. The Claude Console workspace behind the gateway has a monthly spend limit of its own, above the gateway's caps, as a backstop.
- **Running out of credit is a cap the factory does not own, and it says so.** When the provider refuses because the account's credit is spent or the workspace's limit is reached, the gateway treats it as its own typed failure, not a rate limit: it does not retry, it appends `spend.capped` naming the provider as the cap, and every agent call waits as it does at the factory's own caps, with the console saying why. The gateway tries one call every few minutes, and the first that succeeds appends `spend.cleared`. The same holds when LM Studio is not running on `local`. A runner that loses its provider mid-step ends without a handback, and the step runs again from its cassettes once the provider is back, paying only from where it stopped.

### The app's gates

- **The journeys gate compares, because the app is broken on purpose.** The probes and the crawler run against the base's image and the pull request's image in the runner, and the gate fails only on a check that passes on the base and fails on the change. Checked against the seeded app alone, every pull request would fail. The probes and the crawler are the factory's, run from the `factory-browser` image at a pinned digest by a shared workflow, so the app's repository cannot change them. They run against the app's container, not a k3d cluster in the runner: `kustomize build` already proves the manifests, and a cluster would add a minute for nothing the journeys check. Spec section 4.1 changes to say so.
- **Test integrity fails a change that weakens a test.** An existing test deleted, skipped, or left with fewer assertions fails the check and names what changed; adding tests passes. A fix that fails it holds for Martin, who can close it or send it back. It is a shared workflow, out of the app's reach.

### Housekeeping

- **Tickets reach GitHub when work on them starts.** When a ticket enters Plan, the App opens an issue from the ticket's public view, and the fix's pull request refers to it. The issue closes when its fix is verified (milestone 6). Tickets that are never worked on stay in the console only.
- **Events change by version.** Version 1 is frozen by real events, so `model.called`, `review.submitted`, `spend.capped` and `spend.cleared` gain a version 2 with an upcaster: a local provider and any pinned model, the number of calls in an agent's step, the describer as an agent, each finding with its rule, and a provider's refusal as a cap. One `model.called` event records each agent's step; the gateway's `model_calls` table keeps every call.

## Part A: the factory's hands

Each task is its own pull request, in order, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above, and settled anything this file asks him.
- Martin has created the GitHub App on his account, installable only there, with no webhook and no user authorisation. It may read and write contents, pull requests, checks and issues, with metadata read-only and nothing else. It is installed on the two public repositories only. Its avatar is the design system's mark, so its work never wears Martin's face.
- The App's private key is in Martin's macOS Keychain as `factory-github-app-key`, base64-encoded, because `security find-generic-password -w` prints a value with newlines as hex. `make up` decodes it.
- Martin has an Anthropic API key for a Claude Console workspace of its own, with a monthly spend limit above the gateway's caps, in the Keychain as `anthropic-api-key`.
- LM Studio serves `qwen/qwen3.8-27b` on `127.0.0.1:1234` on Martin's Mac.

### 1. The GitHub worker

In `apps/factory/src/github`, run by `factory github`:

- Installation tokens from the App's key, made when needed and never logged. The key reaches the cluster as the TypeSafe key does: `make up` creates the Secret from the Keychain, through stdin and no file. Without it the worker runs read-only and says so.
- Commits through GitHub's API, so they are signed; branches; opening, updating and readying pull requests; comment reviews anchored to lines; check runs; issues.
- Polling, with conditional requests: check runs on the factory's pull requests, merges, and new images in GHCR. Each change is handed to whatever waits for it.
- A dry-run mode that writes what it would have done to the artifacts store and touches nothing, for the unattended passes.
- NetworkPolicy: the worker reaches GitHub and GHCR on port 443, Postgres and the collector, and nothing else.
- A test that the App's token is refused when it writes to `.github/workflows`, with GitHub's refusal kept: milestone 9's red-team harness shows it.

### 2. Deploy and release pull requests from the App

- The worker opens and updates the deploy pull request for each image, in both repositories, when GHCR has a newer image built from `main` than the pin. One open deploy pull request per image, as now, labelled with its profile.
- It runs release-please as a library with the App's token, for both repositories: the release pull request, and the release and tag when it merges.
- `build.yml` builds and pushes images and opens nothing. `release.yml` goes. `scripts/github-settings.ts` stops workflows opening or approving pull requests, in both repositories.
- The checks that recognise a deploy pull request recognise the App as its author.
- ADR 0005 and `COMPONENTS.md` say the App opens them.

### 3. Code-owner review

- `scripts/github-settings.ts` splits the ruleset as the decisions say, for both repositories: review with the admin bypass for pull requests only, and everything else with no bypass.
- `.github/CODEOWNERS` in both repositories loses its line saying review is not yet required.
- The worker keeps the App's pull requests current with `main` until they are ready for review.
- Scorecard runs after the change, and its Branch-Protection score, with what it docks for the bypass, goes in this file's results.
- ADR 0009.

### 4. The app's gates

In this repository, as shared workflows the app's repository calls at a pinned commit, added to its required checks:

- **Journeys:** the probes and the crawler, against the base's image and the change's, in the runner; fails on a check that passes on the base and fails on the change. Axe is part of the crawl, so accessibility on the changed pages comes with it.
- **Test integrity:** as the decisions say.
- **Tests first:** the change's new and changed tests run against the base's source; reports which fail there. Not required: the line reads it.
- **Dependency review and image scan:** GitHub's dependency review, and Trivy on the change's image, each failing only on what the change introduces.

And the app's whole set of checks stays under three minutes. Dependabot's npm updates in the app's repository are diagnosed and fixed (from the backlog).

### 5. The gateway speaks Anthropic

- `POST /v1/messages` in Anthropic's shape, streaming included, for runners. A job token in place of a key says which work item and agent a call is for; the gateway refuses a token whose job has ended, and every agent call while the line is stopped.
- Providers behind it: Anthropic, with the key from the Keychain; and LM Studio on `local`, which the `local` overlay lets the gateway reach at `0.250.250.254:1234` and nothing else on the host.
- Cassettes keyed as the decisions say, with the provider in the key; replay falling through to record at the first miss.
- Prices for Sonnet 5.5, Opus 5.5 and Haiku 4.5, cached reads and writes included, and nothing for local models; every call in `model_calls` and against the caps.
- `policy/models.ts`, and `policy/spend.ts` at $5 per work item on `local` while it is measured.
- A provider out of credit, or LM Studio not running, caps spend as the decisions say. What the API returns for spent credit and for a workspace's limit is found out first, by setting the workspace's limit below what it has spent, and the gateway recognises each by its type and status where it can, and by its message only where nothing else tells them apart.
- Version 2 of `model.called`, `spend.capped` and `spend.cleared` (the decisions), with their upcasters.

### 6. The runners

- The `factory-runner` image: Node, pnpm, git, the app's toolchain and the Agent SDK, built by `build.yml` and pinned like the others.
- The `runners` namespace: a Job per step with a prepare pod and an agent pod (the decisions), a deadline, a turn limit, the restricted Pod Security Standard, and a volume that lives as long as the work item, so the coder can resume its session. The line worker may create Jobs there and nothing else; `make egress` shows an agent pod reaches only the gateway and the handback.
- The handback: `POST /v1/handback`, taking a job's result with its token, checked with Zod at the door.
- Tested with hand-written cassettes: an agent that edits one file, one that strays out of scope, one that runs out of turns, one that hands back nothing.
- A smoke run on the local model: a runner fixes a seeded off-by-one in a scratch copy of the app, and the dry-run worker shows the commit it would have made.

### 7. A redirect loop filed under the page that loops

The probe that follows the home page's links files a loop under the destination's route, not the page holding the link (from the backlog).

### 8. Documentation for Part A

`COMPONENTS.md` (the GitHub worker, the runners, the gateway's providers, the network policies, the App's pull requests), `AGENTS.md` (running the GitHub worker and a runner on the host), ADRs 0008 and 0009, and spec sections 4.1 and 9.

### Part A is done when

- [ ] The App opens the deploy and release pull requests in both repositories, their checks run without Martin approving them, and no workflow can open or approve a pull request.
- [ ] Code-owner review is required on `main` in both repositories; Martin's own pull requests merge through the bypass, and the merge records it. Scorecard's Branch-Protection score is recorded.
- [ ] A pull request to the app that breaks a journey, deletes a test, or adds a vulnerable dependency fails its checks, and one that only fixes a seeded defect passes them.
- [ ] A runner, on the local model, fixes the scratch defect and hands back a patch that the dry-run worker would commit; the hand-written cassettes pass in CI with no key.
- [ ] An agent pod reaches only the gateway and the handback, and the gateway refuses its token once the job ends.
- [ ] With the workspace's limit reached, or LM Studio stopped, agent calls wait, the console says why, and they resume by themselves when the provider answers again.

## Part B: the agents

### 9. The line after triage

In `apps/factory/src/line`, run by `factory line`:

- A queue of work items by stage, in Postgres with leases, as the inbox is, taking the oldest open ticket of the highest severity into Plan, one work item at a time.
- For each stage, a runner, its handback, and the events: `spec.written`, `pull-request.pushed`, `gates.started` and `gate.finished` from the check runs the GitHub worker reads, `review.submitted`, `work.returned` for each round, `model.called` for each step, and `hold.started` when the work item waits for Martin's merge, or for anything else that routes to him. `pull-request.merged` when he merges.
- When the line stops, it deletes running jobs and takes nothing new, and the gateway refuses agent calls. Starting again resumes from the last event.
- The ticket's issue when it enters Plan.

### 10. The planner

- Reads the ticket's typed fields and evidence, never a visitor's words, and the app's repository read-only.
- Writes the spec in the fixed template: outcome, Given/When/Then criteria, the files that may change, risk tags, rollout. Checked with Zod: a scope never names `.github/`, `deploy/` or a path in CODEOWNERS.
- Rejects a ticket it cannot make testable, or asks Martin a question through a hold.

### 11. The coder

- Reads the spec, the ticket's evidence and the app's `AGENTS.md`; writes the failing test, then the fix; hands back the patch and its note.
- The line worker refuses a patch outside the spec's scope back to the coder once, with the paths; a second time, the work item holds for Martin.
- The GitHub worker opens the pull request as a draft, with the ticket's issue and the spec, and readies it when the describer has written its description.

### 12. The reviewer and the loop

- Reads the diff, the spec and `docs/REVIEWERS.md` from the base commit, once the gates pass; posts a comment review with findings anchored, marked and citing their rules, and a check run.
- Blocking findings resume the coder's session; two rounds at most (the decisions).
- `factory reviews rules` counts findings by rule from the event store: a rule never cited can go, and one cited often becomes a lint rule, or moves into `AGENTS.md` if it is an invariant.

### 13. The describer

- The vendored visual-pr skill at a pinned commit, with its licence, changed as the decisions say.
- Writes the pull request's description, and the work item's summary paragraph (`work-item.summarised`, from the backlog).
- The spec's line on pull request templates, and the templates in both repositories, become guidance.

### 14. The console

- Real work items through Plan, Build, Gates and Review: the spec, each pull request attempt, each gate, the review thread with its findings and rules, the rounds as return arcs, and the wait for Martin's merge as Needs you.
- The model row shows a local model as one, at no cost.
- New states are designed and agreed with Martin before they are built, and added to the design system's README. Snapshots are updated in the pinned image.

### 15. Cost, and the soak

- Every agent step's tokens, cache reads and cost, per agent and per fix, from the work items this part runs, in this file's results, with a proposed per-work-item cap for every profile in `policy/spend.ts`.
- An overnight soak on the local model, with the GitHub worker in dry-run: the line takes ticket after ticket, and in the morning no lease is stuck, no job is left behind, every event is valid, and the spend is nothing.

### 16. The fix

The line runs on the local cluster, on Claude, over the tickets milestone 4's senses opened, until a fix for a seeded defect has passed its gates and review and Martin has merged it. Nobody involved in it reads the private repository or chooses the ticket. Each work item that does not get there is in the results, with why.

### 17. Documentation and retrospective

Spec sections 4.1, 7 and 9; `COMPONENTS.md` (the line, the agents and the App's pull requests); `TERMS.md` (runner, handback, patch, if they need pinning down); `TYPESAFE.md` if anything changed for triage; this file's results and retrospective, and the backlog.

## Exit criteria

- [ ] Part A's criteria are met.
- [ ] A seeded defect is fixed and merged in the app's repository with no human code: a ticket from the senses, a spec, a failing test then a fix, the gates, review with at least the chance of a second round, a description, and Martin's merge. Every step is in the console.
- [ ] Every pull request the factory opens is the App's and signed, and waits for Martin's code-owner review.
- [ ] The sandbox never held a credential beyond its job token, and a patch outside its scope never reached GitHub.
- [ ] What a fix costs is measured, and the per-work-item cap is set from it.
- [ ] `make stop-the-line` stops a running agent within a minute, and starting again loses nothing.
- [ ] Martin has watched a fix go through the line in the console, on a laptop and a phone, and approved it against the bar in `INTENT.md`.

## Out of scope

- Canary, verify, closing a ticket and its issue, and the scoreboard (milestone 6).
- Answering Needs you in the console, improvements, and the audit log view (milestone 8).
- Guarded autonomy, where the gates rather than Martin decide a merge (milestones 8 and 10).
- The factory changing its own repository: in this milestone it fixes the app only.
- Checking that every acceptance criterion has a tagged test: the gate would have to trust a spec that only the event store holds. In the backlog.
- The Bedrock provider (milestone 11), and the Batch API for evaluation sets until there is a set of agent evaluations to run.

## Risks

- **Part A is all plumbing, and plumbing hides surprises from GitHub.** The App's commits and branch updates must be signed, its pull requests must run their checks, and Scorecard may dock the bypass. Tasks 1 to 3 land first, and each is proved on a real pull request before the next.
- **The first fix costs more than expected.** The gateway's cap per work item holds it, replay-record pays only from the first changed call, and the local model takes every run that tests plumbing.
- **The coder fixes more than its ticket.** The scope fence, a reviewer told to review the diff and not the shop, and test integrity.
- **An approval goes stale.** A branch update after Martin approves dismisses the approval. The worker updates branches only before a pull request is ready, and Martin merges when he approves.
- **The journeys gate is flaky.** A probe that fails once on the change and passes on the base fails the gate. Each check already needs two failures in a row to signal; in the gate, a check fails only if it fails on the change twice.
- **Determinism ends replays early.** A test's timings in a tool result change the next request. Runners report test results without timings where the tools allow.
- **Prompt injection through the repository.** A file in the app can say anything to the coder. The coder holds no credential, reaches only the gateway, and hands back a patch that a deterministic fence and the gates judge.
