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
- Martin has created the GitHub App, `mrogan-software-factory` (its work shows as `mrogan-software-factory[bot]`), on his account, installable only there, with no webhook and no user authorisation. It may read and write contents, pull requests, checks and issues, with metadata read-only and nothing else. It is installed on the two public repositories only. Its avatar is the design system's mark, so its work never wears Martin's face.
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

- [x] The App opens the deploy and release pull requests in both repositories, their checks run without Martin approving them, and no workflow can open or approve a pull request.
- [x] Code-owner review is required on `main` in both repositories; Martin's own pull requests merge through the bypass, and the merge records it. Scorecard's Branch-Protection score is recorded.
- [ ] A pull request to the app that breaks a journey, deletes a test, or adds a vulnerable dependency fails its checks, and one that only fixes a seeded defect passes them.
- [ ] A runner, on the local model, fixes the scratch defect and hands back a patch that the dry-run worker would commit; the hand-written cassettes pass in CI with no key.
- [x] An agent pod reaches only the gateway and the handback, and the gateway refuses its token once the job ends.
- [ ] With the workspace's limit reached, or LM Studio stopped, agent calls wait, the console says why, and they resume by themselves when the provider answers again.

## Part B: the agents

### 9. The line after triage

In `apps/factory/src/line`, run by `factory line`:

- A queue of work items by stage, in Postgres with leases, as the inbox is, taking the oldest open ticket of the highest severity into Plan, one work item at a time.
- For each stage, a runner, its handback, and the events: `spec.written`, `pull-request.pushed`, `gates.started` and `gate.finished` from the check runs the GitHub worker reads, `review.submitted`, `work.returned` for each round, `model.called` for each step, and `hold.started` when the work item waits for Martin's merge, or for anything else that routes to him. `pull-request.merged` when he merges.
- When the line stops, it deletes running jobs and takes nothing new, and the gateway refuses agent calls. Starting again resumes from the last event.
- When a work item ends, merged or closed, the line deletes its volume (`Runners.finish`).
- A step tried again starts clean. `Runners.run` treats a 409 on create as "made already", so a retry under a name whose Job is still being deleted would read the old Job's status: each attempt gets a name of its own, or the line waits for the delete to finish.
- The GitHub worker refuses to move or delete a branch the factory does not own. Today `setBranch` will force-move, and `deleteBranch` delete, any branch it is given, and only the rulesets keep `main` safe. It refuses as it already refuses a protected path.
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

- The readers of the version 2 events: the console's projections and the Grafana spend panel read `model.called` (one event per step), `spend.capped` and `spend.cleared` as Part A changed them, and a test holds each reader to the new shapes. Nothing tests that yet.
- Every agent step's tokens, cache reads and cost, per agent and per fix, from the work items this part runs, in this file's results, with a proposed per-work-item cap for every profile in `policy/spend.ts`.
- An overnight soak on the local model, with the GitHub worker in dry-run: the line takes ticket after ticket, and in the morning no lease is stuck, no job is left behind, every event is valid, and the spend is nothing.
- The dry run answers for the pull requests it would have opened. Their numbers are made up and GitHub has nothing at them, so today a line in `dry-run` reads no checks and waits at Gates: the dry run needs to report checks that pass, and a merge after a while, for the soak to go round.

### 16. The fix

The line runs on the local cluster, on Claude, over the tickets milestone 4's senses opened, until a fix for a seeded defect has passed its gates and review and Martin has merged it. Nobody involved in it reads the private repository or chooses the ticket. Each work item that does not get there is in the results, with why.

### 17. Documentation and retrospective

Spec sections 4.1, 7 and 9; `COMPONENTS.md` (the line, the agents and the App's pull requests); `TERMS.md` (runner, handback, patch, if they need pinning down); `TYPESAFE.md` if anything changed for triage; this file's results and retrospective, and the backlog.

## Exit criteria

- [ ] Part A's criteria are met.
- [x] A seeded defect is fixed and merged in the app's repository with no human code: a ticket from the senses, a spec, a failing test then a fix, the gates, review with at least the chance of a second round, a description, and Martin's merge. Every step is in the console.
- [x] Every pull request the factory opens is the App's and signed, and waits for Martin's code-owner review.
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

## Results

### Part A

On 4 and 5 October 2026.

- **The App cannot change a workflow.** Asked for a signed commit adding a workflow, after a control commit it was allowed, GitHub answered `Resource not accessible by integration` in both repositories (`apps/factory/test/github/workflow-refusals.json`). The control commits were verified, signed by GitHub and authored by `mrogan-software-factory[bot]`.
- **The app's gates, on a pull request that changes nothing they judge:** test integrity, dependency review and the image scan pass; tests first fails, as it must for a change with no tests. The journeys gate, run locally against a copy of the app whose about page answered 500, failed on that one check and passed over the 23 the base already fails, in 48 seconds.
- **The gateway on Anthropic and on LM Studio.** A runner's call went to Claude Sonnet 5.5 at medium effort, the policy's choice, though it asked for Opus, and cost $0.0001; the same call on another day, in another session, replayed. On `local`, Qwen answered through the same endpoint, at no cost.
- **A smoke run, outside the cluster.** The line's code, with each Job run as a container of the `factory-runner` image and the agent's container on a network that reached only the gateway and the handback: the coder on Qwen wrote the failing test, ran it, fixed the off-by-one, ran it again, and handed back a two-file patch in 2.8 minutes and 8 turns. The fence passed it, and the dry-run GitHub worker recorded the commit on the seeded base. The containers were set up by hand, for this run only.
- **The smoke run in the cluster.** Through the line's `/v1/smoke`, on Claude Sonnet 5.5, from the app's `main` (`2018349`): prepare in 12 seconds, then the coder wrote the failing test, fixed the off-by-one and handed back the same two-file patch in 4 turns and 14 seconds. It made 4 calls, all answered, for $0.034, with 23,251 tokens read from the prompt cache and 8,739 written to it, though nothing in the factory asks for caching. The fence passed the patch, and the dry-run GitHub worker recorded the commit. The job's token ended when the step did, 24 seconds after it was issued, and from then the gateway and the handback refuse it. The run found a bug: the line deleted Jobs with a request body Node sent without its length, so the prepare Job's pod was orphaned and the agent's Job was not deleted (#90). Run again with #90 deployed, as round 2 (a job's name, and so its token, is used once): the same patch in 4 turns, $0.033, the token ended after 20 seconds, and within 10 seconds of the answer nothing was left in `runners`, its Jobs, pods and volume all deleted.
- **The fences in the cluster.** `make egress`, all 42 checks: the workers, the line (the API server, and nothing else on its port or the node's), the agent pod (the gateway and the handback; no name resolves; not the internet, the Kubernetes API, the metadata address, Postgres, the console, the GitHub worker, the app or the host) and the prepare pod (GitHub and npm; nothing in the cluster). Getting there took two fixes the cluster found: the line's readiness probe asked the step API, which listens on loopback only (#88), and the quota in `runners` refused a pod with no memory limit, which the LimitRange did not supply (#89).
- **Code-owner review, with the bypass.** Both repositories' rulesets match `scripts/github-settings.ts` (`--check`). #69, the first of Martin's pull requests merged after the change, merged through the bypass, and GitHub's rule-suite log records it as one. Scorecard on 5 October 2026 (commit `bd57672`): Branch-Protection 8, up from 4 in milestone 1. It docks the bypass ("settings apply to administrators" is off) and a single required approval. The total, 7.3, is below the 8 the spec asks for. Code-Review scores 0, because none of the last 24 changes was approved by a reviewer, and every merge through the bypass keeps it there until the factory's own pull requests, which Martin approves, make up most changes. Maintained, Contributors, Fuzzing and CII-Best-Practices score 0 as they did in milestone 1.
- **A pod is fenced a moment after it starts.** A pod in `factory` reached LM Studio on the host in its first second, before kube-router had applied its policies; a moment later it could not. The agent pod therefore checks its own fence before it runs the agent.

### Part B

From 5 to 7 October 2026, on the local cluster: tasks 9 to 15 (#96 to #103), the line taking a set number of tickets (#106), and the fixes the first live run found (#110, #111, #114, #115).

- **The fix.** With `LINE_MODE=live` and `LINE_TAKE=1`, on Claude Sonnet 5.5, the line took work item 1001 by its own rule, the oldest open ticket of the highest severity: department pages that redirect to themselves (`redirect-loop` on `/departments/:department`, from the probes and the crawler). Nobody chose the ticket or read the private repository. It opened the app's issue #16; the planner wrote a spec of four criteria and three paths; the coder wrote its tests, then a one-line fix, in the App's draft pull request, app #17; the gates, then the reviewer, passed it; the describer wrote its description and readied it; and Martin merged it on 7 October, for $0.333 in 34 calls. How it got there, by way of a hold and three fixes to the factory, is in the retrospective.
- **What reached GitHub.** Both commits on app #17 are the App's and verified, and it changes two files, both in the spec's scope. All 14 checks passed on its last commit, among them journeys, test integrity and tests first, which passes only when a new test fails on the base. The reviewer approved with no findings, through its comment review and its `factory review` check run. GitHub still wanted a code owner's approval when Martin merged: he merged through the admin's bypass, which the rule-suite log records, so the merge does not count towards Scorecard's Code-Review.
- **In the console.** The console serves all 50 of 1001's public events, from the probes' signal to the merge, and has a state for each (#102).
- **The App's deploy and release pull requests, in both repositories.** It opened the app's release pull request (app #19, 0.1.1, after the fix merged) and its deploy pull request (app #20), and keeps this repository's release pull request (#77) current; it opened every deploy pull request merged here in Part B (#105, #107, #108, #112, #113, #116). Their checks ran with nobody approving them.
- **Three runs in dry run, each read by `factory line soak-check` when it ended:**

  | Run | Model | Work items | How they ended | `soak-check` |
  |---|---|---|---|---|
  | A soak, 6 h 53 min, then `factory line stop` | Qwen | 1002 to 1005, the line's own picks | 1002 merged by the dry run; 1003 held at Plan after two failed steps; 1004 and 1005 stopped mid-step | All clear: no lease past its expiry, no Job or volume left for an ended work item, 167 events valid, 281 calls all local, $0 |
  | One work item, `LINE_ONLY=1007` | Qwen | 1007, a search that ignored case | Merged by the dry run 1 h 57 min after it started, every step first time | All clear: 188 events valid, 90 calls all local, $0 |
  | One work item, `LINE_ONLY=1008` | Claude Sonnet 5.5 | 1008, a search that answered 500 | Merged by the dry run, every step first time, in 18 calls and about a minute of agent time | All clear but spend, $0.186, which a soak expects to be nothing |

  The stop deleted both steps in hand within a minute and took nothing new. In the first soak six of the seven failed steps ran out of their deadline, and Plan took a median of 85 minutes; after the fixes in #103 (the cache below, one step at a time, prompts that stop the planner at a diagnosis), 1007's Plan took 21.
- **The local model's prompt cache.** In the first soak LM Studio reused 14 to 18% of each prompt; in the second, 80 to 93%. Two steps on Qwen at once each wrote at about 5.5 tokens a second, against 13 alone. On the bench, with LM Studio's own reasoning effort lowered and temperature at 0.6, saved as the model's defaults, a planner took 4.5 minutes and a coder 4.4, against about 16 for the planner before.

**What a fix costs, on Claude.** Every call was Sonnet 5.5 at the policy's effort. Work item 1001, step by step, from the gateway's `model_calls`:

| Step | Calls | Seconds | Output | Cache read | Cache write | Cost |
|---|---|---|---|---|---|---|
| Planner | 5 | 14 | 1,340 | 41,821 | 12,454 | $0.053 |
| Coder, round 1 | 7 | 22 | 2,464 | 79,936 | 11,591 | $0.070 |
| Coder, round 2 (changed nothing) | 11 | 31 | 2,601 | 209,951 | 6,582 | $0.084 |
| Coder, round 2 again (changed nothing) | 4 | 12 | 1,176 | 92,481 | 1,851 | $0.035 |
| Reviewer | 4 | 12 | 838 | 29,379 | 11,376 | $0.043 |
| Describer | 3 | 11 | 1,235 | 21,564 | 12,789 | $0.049 |
| **Total** | 34 | 102 | 9,654 | 475,132 | 56,643 | **$0.333** |

- **Per agent**, over 1001 and 1008: the planner $0.053 and $0.046, the coder's first round $0.070 and $0.060, the reviewer $0.043 and $0.033, the describer $0.049 and $0.048. A fix that goes straight through, as 1008 did, costs about $0.19; 1001 cost more because the coder ran twice more after a gate sent it back.
- **Where the money goes.** Of 1001's $0.333, writing the prompt cache took 42%, output 29% and reading the cache 29%; fresh input was 68 tokens. Each fresh step writes 11,000 to 13,000 tokens to the cache, about 3 cents; the coder's resumed rounds wrote far less. Read at the price of fresh input, the same calls would have cost about $1.16. 1008 read 146,000 tokens from the cache against 10 of fresh input.
- **On Qwen**, nothing: 1007 took 90 calls and about two hours of steps.
- The costs are the gateway's own, from token counts and `gateway/prices.ts`, not checked against Anthropic's bill.

**A proposed cap per work item: $1, on every profile** (from $5 on `local` and $2 on `do` and `aws`). It is three times the dearest fix measured. A work item that goes the longest way the line allows without a hold (two returns from the gates and one from review, at 1001's prices per step) comes to about $0.50, which leaves room for several steps tried again. Past it, holding for Martin costs less than another round. The day and month caps stay as they are: $20 a day is about 60 fixes at 1001's cost. Two work items on Claude are a small sample, and `policy/spend.ts` is Martin's to change.

## Retrospective

### Part A

Written as Part A's pull requests (#62 to #73, and the app's #9 to #11) merged, with the fixes the first deploy needed (#88 to #90). Its criteria above that are not ticked wait on the runs listed under "Still to run". What Part A taught, and where each lesson now lives.

**Decided**

- Two rulesets on `main`: review, which the admin may bypass to merge, and everything else, which nobody bypasses. ADR 0009. `scripts/github-settings.ts --check` says where the live rulesets differ from it.
- A runner hands back a patch, which the GitHub worker applies outside the sandbox: ADR 0008. The worker checks every patch itself, not only the line: a path outside the repository, a mode other than a plain file's, and `.github/`, `deploy/` or a code-owned path are refused, whatever the line sent. `COMPONENTS.md`.
- The gateway lets through only what the Agent SDK sends, and refuses server tools, which would be a way past the fence: `COMPONENTS.md`.
- An agent pod has no DNS. The line looks up the two addresses it needs and writes them into the pod's hosts: `COMPONENTS.md`.

**Learned about GitHub**

- GitHub accepts the App's Client ID as a token's issuer, so the worker never needs the numeric App ID: `github/app.ts`.
- The App's token cannot write a workflow, even with contents write. The results above, and `workflow-refusals.json` for milestone 9's red team.

**Learned about the cluster**

- The first deploy found what tests could not: a readiness probe on a port that listens on loopback, a quota whose defaults did not cover it, and Node's `https.request` sending a DELETE's body with no length, which the API server read as no body. Each is fixed, and the last has a test against a server that keeps its connections open.
- A pod is unfenced for about a second after it starts, so the agent pod checks its own fence before it runs the agent: the results above, and `apps/runner/src/agent.ts`.
- A NetworkPolicy sees a connection after a Service has translated it. So the line needs only port 6443 on the node to reach the API server through `kubernetes:443`: the policy's comment.
- The work volume outlives each step, so anything on it may be the agent's. The prepare pod checks out afresh each time, with a home, a store and settings of its own, and runs no lifecycle script or pnpmfile. pnpm is in the image, read-only, and runs once at build, because pnpm 12 fetches its native binary on first use. `runners/jobs.ts`, `apps/runner/src/prepare.ts` and the runner's Dockerfile.

**Learned about building it**

- Each pull request had one reviewer, then a review across the whole stack lined up the findings that span pull requests. That found four major problems in the runners and one in the gateway. In each, a side with privileges trusted what the sandbox handed it. Every finding was answered on its pull request.
- In a stack of squash-merged pull requests, every fix low in the stack means rebasing everything above it. Whether Part B tries GitHub's stacked pull requests is still open.
- No test runs the real Agent SDK against the gateway's allow-lists: the [backlog](BACKLOG.md).

**Still to run**

- The App keeping the release pull request (#77 was opened by the old workflow), and opening a deploy pull request in the app's repository.
- The smoke run in the cluster on the local model. It ran on Claude: with Argo CD self-healing, `ALL_LOCAL=true` needs a change through Git, or self-heal paused for the run.
- The workspace's limit set below its spend once, and LM Studio stopped once, to see agent calls wait, the console say why, and the calls resume.
- A pull request to the app that breaks a journey, deletes a test or adds a vulnerable dependency, and one that only fixes a seeded defect.

**Left open:** see the [backlog](BACKLOG.md), and the Part B tasks that gained items from review (9 and 15).

### Part B

Written once the fix had merged. Part B's pull requests are #96 to #103, #106 and the fixes the first live run found (#110, #111, #114, #115), with the app's #17 and #18. Its criteria above that are not ticked wait on the runs listed under "Still to run".

**The fix, and how it got there**

The line took 1001 at 23:45 UTC on 6 October and held it nine minutes later. Twelve of the thirteen checks on its pull request passed; the journeys gate failed it on missing alt text on `/departments/:department`.

- **The gate blamed the fix for a defect the fix uncovered.** With the loop gone, the crawler reached the department's product list for the first time, and found images there without alt text. It filed them under the address it had asked for, not where the redirect landed; and on the base, where no page opened behind the loop, it counted the same check as passed. The crawler now judges a page where it lands, and a route whose link led to no page is "could not tell", not a pass (#110). The gate is as strict as it was: Martin turned down passing a check the base could not run, since a new check would then pass unexamined.
- **The coder rightly changed nothing, and the line called that a failure.** Sent back by the gate, the coder handed back no change, twice, and the work item held as two failed steps, with its reason recorded nowhere. A coder may now change nothing and say why, which holds under the cause that sent the work back (#111). And gates that pass after they sent the work back now let it go on to review (#114); before, any answer to the hold ran the coder again.
- **Then to Martin's merge.** The app's gates moved to the new crawler (app #18), the App brought #17 up to date with the app's main, and every check passed. Martin approved the hold by appending its answer to the store by hand, since the console answers holds only from milestone 8. The reviewer approved with no findings, the describer wrote the description and readied the pull request, and Martin merged it 20 hours after the line took the ticket, three minutes after the line asked him.
- **On the way, the App closed its own deploy pull request.** Moving a deploy branch to a newer build went through main's head, where the pull request had nothing to merge, and GitHub closes such a pull request. The branch now moves in one forced update, never through main (#115).

**Decided**

- A work item's next step is a pure function of its events (`line/machine.ts`), so a stop or a crash resumes from the last event. Each hold names its cause, and `ANSWERS` says what each of Martin's answers does for that cause: `COMPONENTS.md`.
- A handback is kept until its effects are done, and each write in GitHub is recorded as it begins and when it is done, so a retry after GitHub or the store fails never runs the agent again or repeats a write.
- Agents are defined one way (`defineAgent`), with prompts built from typed fields only, never a visitor's words, and results read through a Zod schema; a result the schema refuses is a failed step, and the next attempt is told why.
- `LINE_TAKE` takes a set number of tickets by the line's own rule, so a first live run can be one ticket that nobody chose (#106). `LINE_ONLY` names a work item, for a soak.
- A step on the local model has twice the turns and four times the deadline, set from the soaks' measurements. Agents are developed on Qwen, recorded on Claude, then replayed; only cassettes made from invented work are committed.

**Learned about the agents**

- On Claude every step of both work items was right first time, and a fix costs cents. Specs were tight and fixes small.
- The planner can widen a ticket, and nothing catches it. On Qwen, a ticket about case got a criterion asking a query with no space to find a name with one; the coder rewrote search to match it, and the reviewer approved it, because the spec asked for it. Criteria should trace to the ticket's evidence, and the reviewer should check the spec against the ticket, not only the diff against the spec. For a review of the prompts.
- An agent's account of its own work is a claim. A coder on Qwen, on the bench, said all its new tests failed before its fix; one did not. The fix was right, and checking such a claim is the reviewer's job.
- Qwen makes a good adversary. A weaker model goes off piste where Claude mostly will not: it reproduced defects it was asked only to diagnose, and widened a ticket. Each excursion tested a guard, and the line's mechanics held on both models.

**Learned about the local model**

- Measure before tuning. The first soak's slowness looked like a weak model. It was mostly a prompt cache undone by message order: the Agent SDK puts system messages among the turns, Qwen's template moves them all to the top, and a hybrid model can reuse its cache only to a checkpoint every 2,048 tokens. The gateway now sends them as reminders where they stood (`gateway/providers.ts`). The rest was two steps sharing one GPU.
- LM Studio ignores the effort the gateway sends; its own reasoning-effort field is what counts, and settings made on a loaded model are lost when it reloads unless saved as the model's defaults. Lowering it made the planner on the bench several times faster.

**Learned about the gates and GitHub**

- A fix can make reachable a page the base never reaches, and a defect there then looks like the fix's. Judging a page where it lands covers a fix that redirects to a page the base already reaches; one that reaches a page the base cannot is in the backlog.
- A dry run must refuse what GitHub refuses. The first soak's dry run merged a pull request still in draft, so it went round a path the real line cannot take; it now merges only once the pull request is ready.
- GitHub closes a pull request that has nothing to merge, even one the App means to keep (#115).

**Learned about building it**

- An independent review of the stack found two blockers, a value import that crashed the factory's image and visitors' words reaching the planner through log lines, and about forty smaller defects across seven pull requests. Fixing them bottom up, one sub-agent to a pull request, worked.
- Sub-agents need guard rails they cannot miss. One committed a folder of working notes that its brief said to leave untracked, and undoing it took a history rewrite. A check in the commit hook would have stopped it.
- Merging a stack is slower than building it. Strict checks, signed commits and one approver meant each of eight pull requests needed a local rebase and a CI run before it could merge; GitHub's Update branch drops the signatures.
- A name that can be misread will be. A runner Job's last number counts the work item's steps, and was read as an attempt, which misled the first analysis of a soak; `COMPONENTS.md` says what it counts.
- Spend is recorded in two places when the bench and the cluster share a key, and the gateway's figures are never checked against Anthropic's bill: the backlog.

**Still to run**

- The cap per work item set from the results' proposal, in `policy/spend.ts`, which is Martin's.
- Martin watching a fix go through the line in the console, on a laptop and a phone, and approving it against `INTENT.md`.
- A review that blocks and returns to the coder, and a patch the scope fence refuses, on a real work item. Tests cover both; no run has met either.
- `make stop-the-line` during a step, then starting again, to see the step run afresh and nothing lost. The first soak showed the stop half.
- A night-long soak, for the GitHub worker's memory and leases over many hours, and one on Qwen at the tuned settings over a ticket like 1007.
- Part A's runs still listed above: a pull request to the app that breaks a journey, deletes a test or adds a vulnerable dependency; the provider's cap reached and the console saying why; the smoke run in the cluster on the local model.

**Left open:** see the [backlog](BACKLOG.md).
