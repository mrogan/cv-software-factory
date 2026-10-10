# Milestone 6: Shipping safely

## Outcome

The factory finishes what it starts. A fix that Martin has merged ships as a signed image that admission control lets in, runs as a canary beside the version it replaces, and is compared with it on errors, latency and the probes' journeys while a traffic generator gives the comparison enough to go on. The canary promotes itself or rolls itself back. After full rollout the factory checks that the signal behind the ticket has cleared: if it has, the ticket and its issue close and the scoreboard ticks up; if not, the work goes back round the line.

A deliberately bad change that passes every gate is rolled back by the canary with nobody touching anything, and the rollback becomes a ticket of its own.

The factory stays Supervised: Martin still merges each fix and each deploy pull request. Everything after the deploy merge is unattended.

The milestone is built in three parts, each by its own implementing session, because one context cannot hold all of it:

- **Part A, the runway:** signing, admission control, Argo Rollouts, the canary's analysis and the traffic generator. Every release of the app goes out as a canary and is judged by its numbers, proved with no line in the loop.
- **Part B, the line after the merge:** the line carries a work item through Release and Verify, closes or reopens its ticket and issue, and turns a rollback into a signal.
- **Part C, the score and the show:** the scoreboard, the console's Canary panel and new states, and the runs that show the whole of it.

Each part starts when the one before has met its criteria and its pull requests are merged. Each leaves `COMPONENTS.md` and `AGENTS.md` describing what it built, so the next session starts from this file, those two and the code, and needs nothing from the session before.

## How each part is built

The part's session orchestrates. It gives each pull request to a sub-agent of its own, and keeps its context for the stack. The sub-agent, for its pull request:

1. Builds the task with its tests, and passes `make check`.
2. Has a fresh sub-agent run `/code-review low` on the branch, and fixes what it finds. Where a miss is a hole rather than a bug (tasks 1, 2, 8 and 13), `/code-review medium` and `/security-review`.
3. Writes a short note on the change (why, the decisions it took and turned down, what it left out and where that went, how it was tested) in `scratch/pr/`, and runs `/visual-pr` with the base and the note. The skill writes the description in a context of its own, so the sub-agent's full context does not have to hold the whole diff again.
4. Pushes, and opens the pull request with that description. Copilot reviews it.
5. Answers Copilot. Fixed: reply with the commit and resolve. Wrong: reply with why and resolve. Arguable, or outside the task: reply and leave it open for the orchestrator. `main` needs every conversation resolved before a merge.
6. Reports to the orchestrator: the pull request, what each review found, how it was answered, and what is left open.

Then the orchestrator reviews the stack as a whole, and fixes bottom up, one sub-agent to a pull request, rebasing what is above each fix before anything is pushed again.

## Decisions

### The supply chain

- **Only images the pipeline signed run.** Each repository's `build.yml` signs every image it pushes, by digest, with cosign's keyless signing and the workflow's own OIDC identity, and attaches an SBOM from Syft as a signed attestation. There is no signing key to keep or steal. A signature says which workflow, in which repository, on which ref made the image.
- **Kyverno admits a pod only if its image carries that signature.** In `website`, `factory` (where the console runs too), `runners` and, from Part C, `scoreboard`, a pod's images must be referenced by digest and signed by `build.yml` on `main` of the repository that builds them, and every other registry is refused, but for the few third-party images the policy names by digest with a reason (Postgres, in `factory`). It checks the signature, not the SBOM: the deploy pull requests' checks verify that, where parsing it is cheap. A refusal names the policy and the image. Kyverno fails closed: if it cannot verify, the pod does not start. Its own namespace, Argo CD's and the cluster's system namespaces are left out, so the cluster can always start again; telemetry's and Argo Rollouts' are not guarded, since they run only upstream charts. ADR 0010.
- **Images built on the Mac still run, by Martin's choice.** Running an unmerged image on the local cluster (the `try-the-line` skill) means switching the factory side's policy to audit for the run; Argo CD puts it back when self-heal resumes. The `website` policy stays enforced, always.
- **Deploy pull requests check what admission will check.** The deploy watch proposes only a digest whose signature verifies, and the deploy pull request's checks verify it again, so a pull request that Martin merges never pins an image the cluster would refuse.

### The canary

- **Only the app is canaried.** The factory's own images are signed and admitted, and deploy as they do now. A canary needs traffic to judge, and the app is the only thing with traffic that matters.
- **Argo Rollouts runs the app.** The app's Deployment becomes a Rollout with a stable Service and a canary Service, and Traefik splits the ingress's traffic between them by weight, set by Argo Rollouts. Merging a deploy pull request is still the deployment (ADR 0005): Argo CD applies the new digest, and the Rollout starts a canary from it.
- **The steps are the app's; the judgement is the factory's.** The Rollout's steps live in the app's `deploy/`, which CODEOWNERS gives to Martin and the scope fence keeps from agents. To start: 25% for three minutes, 50% for three minutes, then 100%. The analysis lives in this repository: `policy/release.ts`, which CODEOWNERS gives to Martin, is rendered to a ClusterAnalysisTemplate, as `policy/objectives.ts` is rendered to Prometheus's rules, so nothing in the app's repository can loosen it.
- **The canary is judged against the version it replaces, not against objectives.** The app is broken on purpose, so the version already running fails some objectives; a fix that leaves those as they are is no worse. Three measures, at each step and in the background throughout:

  | Measure | Fails when | From |
  |---|---|---|
  | Errors | the canary's share of 5xx answers is more than a point above the baseline's | Prometheus |
  | Latency | the canary's p99 is more than a quarter above the baseline's, and more than 100 ms above it | Prometheus |
  | Journeys | a check passes on the baseline and fails on the canary, twice | the journeys gate's comparison, run against the two Services |

  The figures are a start, in `policy/release.ts`. A step with too few requests to judge fails, with that as its reason: a change nobody could judge does not reach everyone.
- **Canary and baseline are told apart by Argo Rollouts' pod-template hash.** The collector adds each pod's labels to the app's telemetry, and the analysis queries by the hash Argo Rollouts gives the stable and the canary. The queries sum over routes, so they do not depend on how the app names a route.
- **The journeys measure is the journeys gate, aimed at the cluster.** An analysis Job from the `factory-browser` image runs the same comparison the app's pull requests pass, with the stable Service as the base and the canary Service as the change. One comparison, two places.
- **The traffic generator walks the shop through the front door.** `factory traffic`, in the `factory` image, requests the app's public pages and its search at a steady rate set in `policy/release.ts`, through Traefik, so the split applies to it as to anyone. It runs all the time, so the objectives have traffic too. It never sends a report or the contact form. At about five requests a second, a 25% step of three minutes gives the canary over 200 requests.
- **The senses watch the stable version.** The probes and the crawler look at the stable Service, which is what the shop is between releases. Through the split ingress, `/version` would flip between requests and the senses would throw away every run. The canary is judged by the analysis, not by the senses.
- **A rollback leaves the bad commit on the app's `main`.** Argo Rollouts keeps the baseline running, and every later release carries the bad commit until a fix for it merges, so the next canary fails the same way. That is the gate holding, not a fault: the rollback's own ticket is the way out, and Martin can revert by hand.

### The line after the merge

- **The line carries a work item to Verify.** `release` and `verify` join the line's stages. A merged work item waits at Release under a hold whose cause is the deploy pull request: while the factory is Supervised, that merge is Martin's, and Needs you lists it. The deploy pull request says which work items and tickets it carries, with their issues, so Martin can tell what he is shipping.
- **The line reads the Rollout and changes nothing.** It may get, list and watch Rollouts and AnalysisRuns in `website`, and nothing else there. A release carries every merged work item whose commit is in its image and not in the one before; each gets the release's events, with actor `rollouts`: `release.started` (digest, signed, admitted), `canary.stepped` with each step's analysis, and `release.promoted` or `release.rolled-back` with the series compared. A release that carries no work item (Martin's own commits, Dependabot's) has its events on the line itself, with no work item: the Canary panel and the Release station show it, and if it rolls back, its ticket brings it to the reel.
- **A rollback is a signal.** The line sends one to triage for each measure that failed, with the routes where the canary did worse, the series and the analysis's own words, under the symptom class the measure stands for (`server-error`, `slow-response`, or the failing journey's own). Triage treats it as any sense's signal, so a regression gets a ticket, a fingerprint and a place in the queue. A work item whose release rolled back stays at Release and goes out with the next release that carries it.
- **Verify asks the sense that saw the defect.** After full rollout, the line checks the ticket's own signal against the new version:

  | The ticket came from | Cleared when |
  |---|---|
  | A probe or the crawler | its check, run again against the stable Service, passes twice in a row |
  | An alert on an objective | the alert's expression, over the new version only, stays inside the objective for a window with enough requests |
  | The log watcher | no record of the pattern from the new version for a window with traffic |
  | Only a visitor's report | nothing can tell: the work item holds for Martin, with the screenshots before and after |

  Windows and counts are in `policy/release.ts`.
- **Cleared closes; persists sends the work back.** A cleared signal appends `verification.finished` and closes the work item as verified; the App closes the ticket's issue with what cleared it. A signal that persists returns the work item to Plan with the verification as evidence, once; a second time, it holds for Martin. The issue stays open either way.
- **A closed ticket reopens when its signal returns.** One fingerprint, one ticket: a signal on a verified ticket's fingerprint reopens that ticket and its work item, and the App reopens its issue. The regression is the same defect, not a new one.
- **Pictures are taken while both versions run.** During the canary the probes worker screenshots every page on the stable and on the canary, and compares each pair pixel by pixel; at Verify, those comparisons become the "every page against the version before" evidence, a page marked intended when it is the ticket's own. After full rollout the old version is gone, so the pictures cannot wait.
- **Stopping the line stops agents, and aborts a canary in flight.** `make stop-the-line` runs from Martin's own kubeconfig: it appends `line.stopped`, as now, and aborts any Rollout mid-canary, so the baseline takes all traffic. An aborted release stays aborted until Martin retries it or a new deploy starts another; starting the line does not resume it. The factory itself holds no right to change a Rollout.

### The scoreboard

- **The scoreboard is the only reader of the answer key.** `factory scoreboard` runs alone in a `scoreboard` namespace. `make up` reads each entry's id and fingerprint, and nothing else, from the private checkout (`PRIVATE_DIR`, by default beside this one) into a Secret there, through stdin and no file, as it does the model keys. No other service account can read that namespace's Secrets, and its pod reaches Postgres and nothing else; nothing can call it. A cluster with no private checkout runs it without a key, and the console says the scoreboard is off.
- **It matches by fingerprint alone.** A ticket matches an entry with the same symptom class and route (either may be `*`), or the same page with the entry's text in the ticket's. The rule is `workshop/count.ts`'s, and the private repository's tests check the two agree.
- **It publishes figures, not matches.** It appends `score.updated`, with no work item, whenever a figure changes: found (entries with a matching ticket), verified fixed (entries whose matching ticket was verified), the median time from a matched ticket's first signal to its verification, and false positives (tickets that match no entry). Which ticket matched which entry stays in its own table: a per-ticket verdict in the event store would tell anyone reading it which open tickets are real. The console shows the first three figures; the fourth is published with the results (spec 10.2).

### Events

- **Events change by version, as in milestone 5.** The release events and `verification.finished` exist, written so far only by the samples; where their shape changes, they gain a version 2 with an upcaster, and the samples move to it. New: `score.updated`, and whatever reopening a ticket needs that the console's REOPENED chapter does not already read.

## Part A: the runway

Each task is its own pull request, in order, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above, and settled anything this file asks him: the steps, the analysis's figures and the traffic rate in particular.
- The app's deploy pull request waiting today carries the fixes for work items 1001 and 1006 (app #17 and #25). It stays open until the canary is in place, so they ship through the first canary, and Part B verifies them.

### 1. Signed images

- Both `build.yml` workflows sign each image by digest, keyless, and attach the Syft SBOM as an attestation, with `id-token: write` for that job only.
- The deploy watch checks a digest's signature before it proposes it, and the deploy pull request's checks verify it again.
- `cosign verify` against each repository's identity passes for a new image, and fails for an image built and pushed by hand.
- The app's repository gets a `.github/copilot-instructions.md` like this one's, pointing at its `docs/REVIEWERS.md`, with its first pull request of the milestone, so Copilot reviews the app's changes against the app's rules.

### 2. Admission control

- Kyverno, installed by Argo CD from its chart at a pinned version, in a namespace of its own, before anything it guards.
- The policy, as the decisions say; its NetworkPolicy lets Kyverno's admission controller reach GHCR and Sigstore's trust root. A NetworkPolicy cannot name a host, so the rule is the internet on 443 outside private addresses, as for the GitHub worker; egress by host name is an issue on milestone 10.
- An unsigned image, and one signed by another identity, are refused in each guarded namespace, and Kyverno's words are kept (`deploy/test/admission-refusals.json`), as milestone 5 kept the App's refusal to write a workflow: milestone 9's red team shows them.
- The `try-the-line` skill switches the factory side's policy to audit for a run, and checks it is back to enforce afterwards.

### 3. Argo Rollouts

- Argo Rollouts, installed by Argo CD at a pinned chart and image. Its Traefik traffic router is built in, for Traefik 3's `traefik.io` API, so no plugin is fetched at start.
- In the app's repository: the Deployment becomes a Rollout with the steps above, a stable and a canary Service, and the ingress routed through Traefik's weighted service. The website AppProject allows what that needs, and nothing cluster-scoped.
- The collector adds pod labels to the app's telemetry.

### 4. The analysis and the traffic generator

- `policy/release.ts`, and the ClusterAnalysisTemplate rendered from it, with a test that the two agree (as the alerting rules have).
- The journeys comparison as an analysis Job, from `factory-browser` at a pinned digest.
- `factory traffic`, with its NetworkPolicy: DNS, Traefik and the collector, and nothing else.
- A step with too little traffic fails, and says so.

### 5. Stop the line, and the fences

- `make stop-the-line` aborts a canary in flight.
- `make egress` covers Kyverno, the Rollouts controller, the analysis Job, the traffic generator and the app's own pods, which a NetworkPolicy from this repository fences: DNS and the collector out; Traefik, the probes, the crawler and the analysis in.

### 6. The first canaries

On the local cluster, with no line in the loop:

- **A good release:** Martin merges the app's waiting deploy pull request; the canary goes through its steps, the analysis passes each, and it promotes itself. The step timings, request counts and each measure go in this file's results.
- **A bad release:** a drill on the app's `main`, written to pass every gate and fail under load (a lock that serialises requests, say, which a single probe never notices). Its deploy pull request merges, the canary fails its analysis and rolls back before 100%, and nobody touches anything. Then Martin reverts it by hand, and the revert's release promotes.

### 7. Documentation for Part A

`COMPONENTS.md` (supply chain, admission control, progressive delivery, the traffic generator, the guardrails it makes real), `AGENTS.md` (the traffic generator on the host; trying an unmerged image under admission), `TERMS.md` (canary, baseline as the version a canary is compared with, as distinct from the seeded baseline, rollback, and abort as distinct from a rollback), ADR 0010, and spec sections 4.1 and 8.

### Part A is done when

- [ ] Every image both repositories build is signed by their pipeline, with its SBOM attested.
- [ ] An image the pipeline did not sign is refused in every guarded namespace, and the refusals are kept.
- [ ] Merging a deploy pull request runs the app's release as a canary that the analysis judges on errors, latency and journeys against the baseline, with enough traffic to judge, and that promotes itself.
- [ ] A change that passes every gate and fails under load is rolled back by the canary, unattended, before it reaches 100%.
- [ ] `make stop-the-line` aborts a canary in flight, and `make egress` passes with the new parts.

## Part B: the line after the merge

### 8. Release

- `release` and `verify` in the line's stages and its table; the machine stays a pure function of a work item's events.
- The deploy pull request lists the work items, tickets and issues it carries. A merged work item holds at Release for it.
- The line's read-only watch of the Rollout and its AnalysisRuns, and the release events, on each work item a release carries or on the line itself.
- Work items that merged before this part (1001 and 1006) take their place at Release; if their commit is live already, Release records that and Verify runs.

### 9. Verify, close and reopen

- Verification for each kind of ticket, as the decisions say, with `verification.finished`.
- Closing: the work item closes as verified, and the App closes the issue with a comment saying what cleared it.
- Persisting: back to Plan with the verification as evidence, once, then a hold.
- Reopening: a signal on a verified ticket's fingerprint reopens the ticket, its work item and its issue (a new action for the GitHub worker, which the dry run records too).

### 10. Pictures

- The probes worker screenshots every page on the stable and the canary while the canary runs, with each pair compared pixel by pixel, as artifacts.
- The ticket's own page at signal, on the canary and after rollout, with the checked element's box, for the sheet's wipe.

### 11. A rollback is a signal

- A failed analysis sends a signal per failing measure, as the decisions say; triage opens a ticket for it, or adds to the ticket it repeats.
- Martin's abort (`make stop-the-line`) ends the Rollout with the same `RolloutAborted` message as a failed analysis, so the signal comes only from an AnalysisRun that failed, never from the Rollout's state alone: an abort is no signal.
- The dry run answers for a release, so a soak still goes round: a dry-run work item is released and verified by the dry run's word, and says so.

### 12. Documentation for Part B

`COMPONENTS.md` (the line through Verify, the release watch, verification by sense), `TERMS.md` (verification, and the line now carrying work to it), spec section 4.1's Release and Verify, and ADR 0011 if verifying by the ticket's own sense needs its reasoning kept.

### Part B is done when

- [ ] Work items 1001 and 1006 are verified against their own checks, and their issues (app #16 and #24) are closed by the App with what cleared them.
- [ ] A release's events, step by step, are on every work item it carries, and a release that carries none is on the line.
- [ ] A rollback opens a ticket with the series that condemned it.
- [ ] A signal that persists after release sends its work item back to Plan, and a verified ticket whose signal returns reopens, each shown by a test and by one run.

## Part C: the score and the show

### 13. The scoreboard

- `factory scoreboard`, its namespace, its Secret from the private checkout and its fences, as the decisions say. Admission control guards the namespace, and the admission tests refuse an unsigned image there too. `make egress` shows it reaches only Postgres, and a test shows no other service account can read its Secret.
- `score.updated` when a figure changes, and the figures checked against `workshop/count.ts` over the same tickets.

### 14. The console

- The Canary panel: the release in flight against its baseline on errors, latency and journeys, with its steps, for everyone. Promote, hold and roll back are admin's, in milestone 8; the panel says the canary decides for itself.
- The scoreboard beside the app's name: found, verified fixed, and median time to verified fix.
- Release and Verify for real work items: the hold for the deploy, each step's analysis, the rollback picture, the wipe at signal, canary and rollout, every page against the version before, a return from Verify, a reopened ticket, and a release with no work item.
- New states are designed and agreed with Martin before they are built, and added to the design system's README as a section of their own. Snapshots are updated in the pinned image.

### 15. The runs

On the local cluster, on Claude, at Supervised:

- **A fix all the way.** The line takes a ticket by its own rule and carries it through Plan, Build, Gates and Review to Martin's merge, and on through his deploy merge, the canary, promotion and Verify, until its issue closes and the scoreboard ticks up. Nobody chooses the ticket or reads the private repository. How long each stage took, from the signal to verified, goes in the results.
- **A bad change, unattended.** A drill as in Part A, released with a fix: the canary rolls it back, the fix's work item waits at Release, and the rollback's ticket is in the reel. If the line takes that ticket, its fix and its release go in the results too.
- Martin watches both in the console, on a laptop and a phone, and approves them against `INTENT.md`.

### 16. Documentation and retrospective

Spec sections 3.2, 4.1 and 5.2; `COMPONENTS.md` (the scoreboard, the console's new panels); `TERMS.md` if anything needs pinning down; this file's results and retrospective; open question 3 with what the runs measured; the issues.

## Exit criteria

- [ ] Parts A and B's criteria are met.
- [ ] A seeded defect is found, fixed, merged, shipped as a signed canary, promoted, verified by its own signal clearing, and closed, with its issue, with no human code and nobody touching it after the deploy merge. The scoreboard counts it. Every step is in the console.
- [ ] A bad change that passes every gate is rolled back automatically, never reaches all traffic, and opens a ticket.
- [ ] No image the pipeline did not sign runs in a guarded namespace.
- [ ] Only the scoreboard can read the answer key, and nothing but its figures leaves it.
- [ ] Martin has watched a fix and a rollback in the console, on a laptop and a phone, and approved them against the bar in `INTENT.md`.

## Out of scope

- Promote, hold and roll back from the console, the auto-rollback switch, and answering Needs you there (milestone 8).
- Guarded autonomy, where the gates rather than Martin merge a deploy pull request (milestones 8 and 10).
- The injector and its menu (milestone 9): this milestone's drills are Martin's own commits.
- Canaries for the factory's own images.
- Dependabot's pull requests as work items of their own: their releases are on the line, with no card unless they roll back.
- Profiles other than `local` (milestones 10 and 11).
- Admission on SLSA provenance, beyond the signature.

## Risks

- **The laptop runs out of room.** Kyverno, Argo Rollouts, a second copy of the app and the traffic generator join a cluster that already runs the line. Part A measures what each takes, and the traffic rate is policy.
- **Admission fails closed, so an outage stops every pod.** GHCR or Sigstore out of reach, or Kyverno itself down, and nothing in a guarded namespace starts. Kyverno caches what it has verified, its own namespace and the system's are left out, and `make up` installs it before what it guards. Its cache is in memory, so a Kyverno that restarts verifies everything again; its memory grows with the largest Sigstore bundle attached to an image, its attestations' included, which its limit allows for; and the policy verifies the signature, not the SBOM.
- **A noisy baseline makes a noisy verdict.** The seeded defects make some routes slow or failing by design. The analysis compares with the baseline rather than objectives, sums over routes, and needs two journey failures; each rollback in the runs is checked by hand for whether it was earned.
- **The traffic generator wakes the objectives.** Seeded slow routes that were too quiet to alert will alert under traffic. They are real defects, triage deduplicates them by fingerprint, and the scoreboard counts what they find; the results say how many tickets the traffic brought.
- **A rollback holds every release behind it.** Until its fix merges, each release carries the bad commit. Its ticket takes its place in the queue by severity, and Martin can revert.
- **The answer key leaks.** Only ids and fingerprints reach the cluster, only the scoreboard can read them, and only its figures leave it.
