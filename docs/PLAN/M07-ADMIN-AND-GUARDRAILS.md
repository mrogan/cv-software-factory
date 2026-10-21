# Milestone 7: Admin and guardrails

## Outcome

Martin runs the factory from the console, not from the command line or by hand in the store. He signs in with a passkey and answers what waits on him in Needs you. He also stops and starts the line, sets the autonomy level and the switches, promotes, pauses, rolls back and retries a canary, chooses each agent's model and effort, sets the spend caps within what policy allows, and reads the audit log. Everything he can change, a visitor can see, drawn read-only, so the controls that make the factory safe are part of the demo.

He asks for an improvement with the "+" on Plan. It goes down the same line as a fix and ships behind a feature flag that he switches from the console in stages. Verify compares the flag's two sides before everyone gets it.

Every guardrail is proved by a test or by a drill that runs from one command, and its refusals are shown as prominently as successes. Autonomy does what the spec says: under Guarded, an untagged change merges and ships with nobody touching it, and a risk-tagged one waits for Martin. The tags come from deterministic checks on the diff, and the decision to merge is a required check, never a model's word.

The milestone is built in three parts, each by its own orchestrating session:

- **Part A, admin:** sign-in, the access policy, the admin service and its write path, every control in spec 5.4 but the improvements and flags, alerts to Martin, and the local cluster served over HTTPS.
- **Part B, improvements and feature flags:** the "+" end to end, OpenFeature and flagd in the app, flags switched from the console in stages, and Verify comparing a flag's two sides.
- **Part C, guardrails:** every guardrail proved repeatably, the red-team harness, blocked actions in the console, approval routing by autonomy level and risk tag, and the factory run Guarded.

Each part starts when the one before has met its criteria and its pull requests are merged. Each leaves `COMPONENTS/` and `AGENTS.md` describing what it built, so the next session starts from this file, those two and the code, and needs nothing from the session before.

## How each part is built

The part's session orchestrates with the `/implement` skill (`.claude/skills/implement`): it writes a brief for each task from this file, and a sub-agent takes each to a pull request, one at a time, its report checked before it is believed. On top of what the skill does:

- **`/security-review` on every Part A pull request,** and on any in B or C that touches sign-in, the admin service, a credential, a fence or the approval routing. Each brief says so.
- **The orchestrator does what a worker skips:**
  - a deploy pull request that waits for an image, opened once Martin has merged the change that builds it;
  - a proof on the local cluster, run with the `try-the-line` skill on Claude, time-boxed and within the spend caps;
  - a drill.

  Each is in the run's summary until it is done.
- **Console designs come first.** Martin is not a frontend developer, so each new view is drawn in the mockup and the design system's README, and agreed with him before it is built. Snapshots are updated in the pinned image.
- **Work in the app's repository** (Part B's OpenFeature and flagd) goes through `/implement` too, once task 13 lets it take a work item there.

## Decisions

### Who may do what

- **Two roles, one table.** A visitor reads public views. Admin, Martin alone, reads everything and acts. Every route and every action is in one table in `policy/access.ts`, which CODEOWNERS gives to Martin: its role, whether it reads or writes, and, for a write, whether it needs his passkey again. The server enforces the table and refuses anything not in it. The console draws its controls from the same table, so a visitor sees every control, read-only, with what it does. A test fails when a route or an action is not in the table.
- **Visitors see the controls, not the buttons.** The "+" and every improvement's request, spec and progress; the autonomy level and the switches; each agent's model and effort; spend against the caps; the flags and their stages; the audit log; what waits on Martin and how he answered. Visitor features (milestone 8) add the few writes a visitor's key allows; this milestone has none.
- **What a visitor reads is masked at the source.** Every event's public view is written when it is appended (spec 5.1), so the audit log is open to everyone, with what a visitor wrote and anything shaped like a secret already left out. Martin's answers on holds are public, through the same redactor, so a report he quotes stays masked.

### Signing in

- **A passkey, and nothing else.** Martin signs in with a passkey (WebAuthn, user verification required): it cannot be phished, nothing reusable is kept on the server, and it works the same on every profile. There is no password and no third party.
- **Enrolled from the command line.** `factory admin enrol`, run with the store's writer credentials, prints a one-time code that lasts ten minutes and allows five tries; Martin enters it on the console's enrolment page and makes a passkey. He may hold two (a laptop and a phone). `factory admin enrol --revoke-others` is recovery: it revokes every other passkey and every session. Each passkey belongs to its host, so each profile is enrolled on its own.
- **Sessions are kept on the server.** The browser holds only a random id in a cookie named `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`; the store keeps its hash. A session lasts eight hours from sign-in with no idle timeout, a figure in `policy/access.ts`: ASVS asks for an idle timeout, and ADR 0012 records why there is none (one admin, who signs in with a passkey and gives it again for every high-impact action). The id changes at sign-in, signing out ends it on the server, and "sign out everywhere" ends them all.
- **Every change that loosens a control or promotes something needs the passkey again,** given within the last five minutes:
  - raising a spend cap;
  - loosening autonomy;
  - turning auto-merge on, or auto-rollback off;
  - promoting a canary;
  - widening a flag's stage;
  - enrolling or revoking a passkey.

  `policy/access.ts` marks each, and a test holds the spec's list and the table to each other.
- **Every write is defended against forgery:**
  - `SameSite=Strict`;
  - the `Origin` header checked against the console's own;
  - a per-session token in a header;
  - only `POST`, never a write on `GET`.

  Admin responses are `no-store`. A strict Content Security Policy, `frame-ancestors 'none'` and HSTS are on every response. Enrolment and sign-in are rate-limited by client address.
- **Forwarded headers are believed only from the proxy in front.** Traefik on `local`, and Cloudflare's tunnel on public profiles (spec 8). The client's address that the rate limits key on comes from them alone.
- **The bar is OWASP ASVS 5.0 level 2.** A ZAP baseline scan runs in CI against the console with an admin session, and its findings fail the build unless a reason is kept beside the exception. The scan signs in as a real browser would, with a virtual WebAuthn authenticator enrolled against a throwaway store, so no sign-in path made for tests ships in the image. A short threat model goes in ADR 0012.

### The admin service

- **One write path, separate from the console's server.** `factory admin` runs as its own Deployment in `factory`. Traefik routes `/admin/` on the console's host to it, so the browser sees one origin, while the console's server keeps its read-only role and never holds a session or a full event. The session cookie's path is `/`, as `__Host-` requires, so Traefik strips `Cookie` from every request it sends the console's server, and a test proves the server never receives one.
- **Its database role appends Martin's commands and nothing else.** It may append its own event types (holds answered, the line stopped and started, autonomy, switches, settings, release controls, sign-ins) and read the full events Martin's views need. It reads and writes its own tables of passkeys, enrolment codes and sessions, and no other. A test of the grants proves each.
- **It serves Martin the full events.** A live stream of full events, the public one's twin, goes to a signed-in session. Report text is shown to him as spec 5.3 says, inserted as text.
- **It is the one service of ours that may touch a Rollout.** It gets a Role in `website` that may patch the app's Rollout and its status, by name, for promote, pause, abort and retry, and nothing else. `release-fences.test.ts` keeps every other service account away from it, and fails if this Role grows.
- **Every action is an event.** Martin is the actor. The public view says what he did, and the console's audit log reads it like any other event.
- **Stop the line keeps its command-line path.** `make stop-the-line` does not go through the admin service, so it works when the console does not.

### Settings within policy

- **Policy sets the bounds; Martin chooses within them.** `policy/models.ts` names the models each agent may use (Qwen, Claude Haiku, Sonnet and Opus to start, each priced in the gateway) and the highest effort for each. `policy/spend.ts` names each cap's ceiling. Martin's choice is a settings event, and the gateway reads the latest. Raising a ceiling, or adding a model, is still a pull request.
- **A setting applies from an agent's next step,** never part-way through one, and the step records the settings it ran under.
- **The line's take settings join them.** `LINE_TAKE` and `LINE_ONLY` become settings Martin changes in the console, with the variables as their defaults for a line on the host.

### Local HTTPS

Safari drops a `Secure` cookie over plain HTTP, even on `localhost`, and passkeys need a secure context. So the local console is served over HTTPS:

- `make up` creates a local certificate authority with `mkcert` (pinned in `mise.toml`), which the Mac trusts once, and gives Traefik one certificate for the local hosts.
- The console moves to `https://console.localhost:8443`; plain HTTP on it redirects.
- The app's own hosts stay as they are, so the traffic generator and the canary's split are untouched.

Public profiles get their certificates from Cloudflare (milestone 10).

### Alerts to Martin

- **Alertmanager gets a second receiver, Pushover,** beside the intake. Its key comes from the Keychain through `make up`, as the other keys do. Alertmanager has no NetworkPolicy today; it gets its first, which lets it reach the intake and the internet on 443 and nothing else, as Kyverno's rule does until egress by host name (#176), and `make egress` covers it.
- **Three levels, routed by label:**

  | Level | For |
  |---|---|
  | Page | the console or the app down, the line stuck, a spend cap reached, a security event |
  | Notify | a release rolled back or errored, a new hold, autonomy changed |
  | Dashboard only | everything else |

- **Security events come first (Part A):** a sign-in, a passkey enrolled or revoked, every action that needs the passkey again, and every change to a setting. The admin service counts each, and an alerting rule pages on any. Factory health, releases and spend follow in Part C.
- **Whether the factory is up is answered from outside it.** On public profiles, an always-firing alert goes to a dead man's switch, and an outside check watches the site and the console (milestone 10).

### Feature flags (Part B)

- **OpenFeature in the app, flagd beside it.** The app asks OpenFeature, the CNCF's standard API for flags; flagd answers, from a definition it reads as a file. flagd's image is admitted by digest, as Postgres's is.
- **The flag is defined in the change; its state is Martin's.** An improvement's pull request defines its flag, with the flag off. The state of every flag lives in one ConfigMap in `website`, kept out of Git, which only the admin service may write (the same kind of Role as the Rollout's), and flagd reads it as a file. That keeps the app from knowing the factory exists. A mounted ConfigMap changes when the kubelet next syncs it, within about a minute, so a kill switch takes effect within a minute, with no deploy or rollback; if that proves too slow, flagd watches the resource through the Kubernetes API instead.
- **A flag goes out in stages,** each one change in the console:
  1. the factory's own marked requests, so Verify can check the acceptance criteria in production with nobody else seeing the change;
  2. browsers that opt in to preview it;
  3. a share of browsers, sticky by a random id in the app's own cookie;
  4. everyone.

  Off is a kill switch for everyone, and beats a preview.
- **Verify compares a flag's two sides at the share stage.** The factory's marked requests are too few to judge on, and are left out of the judged figures, so stage 1 checks the acceptance criteria and the share stage compares. Each request's telemetry carries the variant it was given (OpenFeature's OpenTelemetry hooks), and Verify judges flag-on against flag-off on errors, latency and journeys, as the canary judges versions. The traffic generator carries a browser id of its own, so both sides get enough requests.
- **A preview is the app's own feature, and harmless.** `?preview=<flag>` sets the app's preview cookie. The console's "Preview it" link uses it during the opt-in stage. The app accepts only flag names flagd knows, never echoes the parameter, and someone who sets it by hand sees a deployed feature in their own browser only.

### Autonomy (Part C)

- **Risk tags that a diff can show are worked out from it.** Deterministic checks tag a change:
  - test-loosening, when a test is deleted, skipped or weakened, as the test-integrity gate judges it (a new test, which every fix brings, is not one);
  - dependency-change, for a lockfile or a package manifest;
  - security-headers, for the header settings.

  Out-of-scope is not in a diff, since the scope fence refuses a file beyond the spec's scope before it reaches GitHub. It stays the planner's tag on the spec, and the reviewer's, held for Martin before any code is written in every mode. The planner and the reviewer may add any tag and hold the work for Martin; neither can remove one.
- **Merging is decided by a required check.** A human-owned approval-routing check passes for an untagged change under Guarded, any change but `out-of-scope` under Lights-out, and anything Martin has approved. It fails any pull request of the App's that touches a path CODEOWNERS gives Martin, but for a deploy pull request that changes nothing except an image's pin to a signed digest, which passes under Guarded. A release pull request waits for Martin in every mode: it publishes a version, and nothing waits on it.
- **The App may bypass the review ruleset only.** That takes away code-owner review as the backstop for the App's pull requests, so the routing check holds code-owned paths in its place. The checks ruleset keeps no bypass, so a fault in the line still cannot merge a tagged change or touch a rule. ADR 0009 changes with it. The bypass's effect on OpenSSF Scorecard's Branch-Protection score is checked before it is made.
- **Autonomy is set in the console.** Loosening it needs the passkey again and pages Martin; tightening is immediate. Lights-out is built and proved, and never the default.

## Part A: admin

Each task is its own pull request, in order, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above.
- The holds waiting in the store, 1002's at Plan among them, stay as they are, to be answered from the console in task 11.

### 1. Local HTTPS

- `mkcert` in `mise.toml`; `make up` makes the local authority, has the Mac trust it, and gives Traefik its certificate as a Secret.
- `deploy/k3d/cluster.yaml` maps `127.0.0.1:8443` to Traefik's 443. A cluster made before this needs making again (`make down`, `make up`), and the task says so where people will see it.
- The console on `https://console.localhost:8443`, with plain HTTP redirecting: its ingress in `deploy/overlays/local/`, the addresses `make up`, `make samples`, `make real-store` and `make status` print, `AGENTS.md`, the e2e tests and the `try-the-line` skill.
- `make up` on a fresh clone still works for someone who declines the trust prompt, and says what they lose.

### 2. The designs

- In the mockup and the design system's README, agreed with Martin before anything is built:
  - the bottom row (Needs you and Controls);
  - sign-in and enrolment;
  - the settings;
  - the audit log;
  - promote, pause, roll back and retry on the Canary panel;
  - preview as visitor;
  - each one's read-only form for visitors.
- The README's "Not decided yet" loses what this settles.

### 3. Sign-in and the access policy

- `policy/access.ts`, and the test that every route and action is in it.
- `factory admin`: its Deployment, NetworkPolicy, Traefik route and database role, with its migration and a test of its grants. A deploy pull request follows its image.
- Passkey enrolment and sign-in, sessions, forgery defences, headers and rate limits, as the decisions say. `factory admin enrol` and `--revoke-others`.
- Tests:
  - every write route refuses no session, an expired session, a revoked one, the wrong origin and a missing token;
  - the cookie's flags;
  - the id changes at sign-in;
  - a WebAuthn challenge cannot be used twice;
  - step-up is enforced;
  - forwarded headers from anywhere but the proxy are ignored.
- The ZAP baseline scan in CI, and ADR 0012 with the threat model.

### 4. Martin's view

- The full-event stream to a signed-in session; the console draws full events for Martin and public ones for everyone else from the same projection.
- A report's text for Martin, as spec 5.3 says.
- Preview as visitor: the public stream, served by the server, not hidden in the browser.

### 5. Needs you

- The bottom row's Needs you: one card per hold, the line's and triage's, with its cause, its evidence and what each answer does (`ANSWERS`).
- Approve, reject or answer in words, appending `hold.answered`; words on a triage hold leave it held, as `WORDS_LEAVE_HELD` says.
- For visitors, the same cards, read-only, with Martin's answers once given.

### 6. Release controls

- The admin service's Role on the app's Rollout, and `release-fences.test.ts` updated to allow it alone.
- Promote (to the next step, or fully), pause, abort and retry on the Canary panel, each an event with Martin as its actor. A retry ends the "until Martin retries it" holds that today take a `kubectl` patch.

### 7. The line's controls

- Stop and start the line from the header, with a reason: the same events as `make stop-the-line`, and a canary in flight aborted through task 6's Role, as `scripts/abort-canaries.sh` does with Martin's own credentials. `make stop-the-line` keeps its own path.
- The autonomy level, recorded; Part C makes it route.
- The switches spec 5.4 names: agents taking new work, and auto-merge of low-risk changes, which does nothing until Part C. Auto-rollback is Part C's.
- The line's take settings, read by the line in place of its variables.

### 8. Models and spend

- The bounds in `policy/models.ts` and `policy/spend.ts`, the settings event, and the gateway reading it at an agent's next step.
- The settings page: each agent's model and effort, all-local, and the caps; raising a cap answers a `spend` hold.
- Spend against today's caps in Controls, for everyone.

### 9. The audit log

- Every agent action, model call and admin action, newest first, filtered by actor, work item and kind; the same view for everyone, from public views.

### 10. Alerts

- Alertmanager's Pushover receiver, its key from the Keychain, and its first NetworkPolicy, with `make egress` showing it reaches the intake and the internet on 443 and nothing else.
- The routes by level, and the security events' rule.
- A test page from Martin's phone: a sign-in pages him.

### 11. The runs

On the local cluster, on Claude, at Supervised:

- Every hold in the store answered from the console, 1002's included, and the line acting on each answer.
- The line stopped and started from the console, and a canary paused, promoted, aborted and retried from it.
- An agent's model changed in the settings, and its next step running on the new one.
- Martin uses it all on a laptop and a phone, and approves it against `INTENT.md`.

### 12. Documentation for Part A

- `COMPONENTS/`: the console, a new admin page, the event store's roles, alerting, the gateway's settings, progressive delivery's controls, and the guardrails table.
- `AGENTS.md`: the console's address, enrolling, and Pushover's key.
- `TERMS.md`: admin, passkey, step-up, setting.
- Spec sections 5 and 8, and ADR 0012.

### Part A is done when

- [ ] Martin signs in with a passkey on a laptop and a phone, in Safari and Chrome, and no write succeeds without his session: the access tests and the ZAP scan pass.
- [ ] Every hold in the store is answered from the console, and the line acts on each.
- [ ] Stop the line, autonomy, the switches, the take settings, the release controls, the models and the caps are each changed from the console, recorded as events, and shown read-only to a visitor.
- [ ] A sign-in pages Martin's phone.
- [ ] The audit log shows every action, with nothing a visitor wrote in its public form.

## Part B: improvements and feature flags

Outlined here, and detailed when Part A is done.

- **13. `/implement` in the app's repository.** A work item may name the app's repository. Its worktree lives under this checkout's `scratch/`, its worker follows the app's `AGENTS.md` and `docs/REVIEWERS.md`, and nothing it writes, in code, commits, pull requests or replies, mentions or hints at seeded defects.
- **14. OpenFeature and flagd in the app.** The SDK, flagd beside the app, its image admitted by digest, the variant on the app's telemetry, the browser id and preview cookies. This is platform work, so one of Martin's sessions builds it, as his drills were.
- **15. Flags in the console.** The ConfigMap, the admin service's Role for it, and the stages and the kill switch in Controls, read-only for visitors.
- **16. Verify by variant.** Verify judges flag-on against flag-off for a work item shipped behind a flag. The traffic generator carries a browser id.
- **17. The "+".** A request from Martin becomes a work item of kind improvement. The planner's spec template takes a flag and its stages, its questions arrive in Needs you, and Martin approves the spec before any code. The server refuses an improvement from anyone else.
- **18. The first improvement.** Dark mode, asked for with the "+", shipped behind a flag, verified on both sides, and switched on for everyone, with no human code.

**Done when:** an improvement goes from the "+" to everyone through each stage, its flag's two sides compared by Verify, and its kill switch shown to work.

## Part C: guardrails

Outlined here, and detailed when Part B is done.

- **19. Proofs in CI.** Tests for what is true today by convention:
  - no workflow uses `pull_request_target` or a self-hosted runner;
  - the reviewer's check is not required, and no gate or merge path calls a model;
  - only the gateway mounts a model key;
  - the runners' network policies render as intended.

  The rulesets' drift check (`github-settings.ts --check`) runs on a schedule.
- **19a. A store role for each worker (#435).** Every worker writes as `factory_writer` today; each gets a role of its own, granted only the tables it needs, with a test of each role's grants.
- **20. `make guardrails`.** One command for the proofs that need the cluster:
  - egress;
  - admission's refusals;
  - the App's refusal to write a workflow;
  - stop the line;
  - a rollback.

  Each records its result as an event with the mechanism's refusal verbatim, so the console says when each guardrail was last proved.
- **21. The red-team harness.** The attacks in spec 5.3, run by Martin from admin, each recording `attack.launched` and the refusal. It adds adversarial inputs in logs and page content for guardrail 8. Milestone 8 puts its menu in front of visitors.
- **22. Blocked actions.** `action.refused` from every mechanism: the gateway, the GitHub worker and Kyverno, beside the scope fence. A guardrails panel: each guardrail, its mechanism, its last proof and its recent refusals, and one line for those that cannot be switched off.
- **23. Approval routing.** The deterministic risk tags, the approval-routing check, the App's bypass of the review ruleset (ADR 0009), and the line reading the autonomy level. A dry-run soak at Guarded, then Guarded for real.
- **24. Auto-rollback's switch.** Off leaves a failed canary paused for Martin rather than rolled back. Switching it off needs the passkey again and pages him.
- **25. Guardrail 10 as written.** Its App answers an outside issue politely. The factory reads no issue as input today, so "acts only on issues it created or Martin labelled" holds by construction; whether a label of Martin's becomes a way in beside the "+" is settled when this part is detailed.
- **26. Alerts for the factory.** Its health (a worker crash-looping, a lease stuck, the store down, Argo CD degraded), releases and spend, at their levels.

**Done when:** every guardrail has a test or a demo that runs from one command and is shown in the console; a fix goes end to end at Guarded with nobody touching it; a risk-tagged change waits in Needs you until Martin approves; and each red-team attack is stopped by its mechanism, with the refusal shown.

## Exit criteria

- [ ] Parts A, B and C's criteria are met.
- [ ] Spec 10.1's scenarios 6, 7 and 8 run on the local cluster and are shown in the console: each red-team attack stopped by its mechanism, a risk-tagged change waiting in Needs you until Martin approves, and an improvement requested, approved and shipped.
- [ ] Spec 10.3's "every guardrail has a test or demo showing it holds" is met.
- [ ] Martin has used admin mode on a laptop and a phone and approved it against the bar in `INTENT.md`.

## Out of scope

- Visitor keys, their usage view, visitor limits and the visitor budget, the injector and its menu, the red-team menu for visitors, and the report widget's text for its sender (milestone 8).
- The replay site (milestone 9).
- Public certificates, the domain, the tunnel, the outside uptime check and the dead man's switch (milestone 10).
- A/B experiments on what people prefer: with no real shoppers, there is nothing honest to measure.
- Canaries for the factory's own images.

## Risks

- **The admin service is a new way in.** It is the only write path a browser reaches. It is small, refuses by default, has its own role and Role, is reviewed for security on every change, and its tests and scan run in CI.
- **Guarded merges into a public repository with nobody watching.** A dry-run soak comes first, the routing check rather than the line decides, the canary's rollback is the guard after the merge, and tightening autonomy is one click.
- **Flag state lives outside Git.** It is the one piece of production state Argo CD does not hold. Every change is an event, so the audit log is its history, and a flag's default in the app's code is off.
- **Alertmanager reaches the internet.** It is allowed out on 443 as Kyverno is, until egress by host name (#176).
- **The local authority is trusted by the Mac.** Its key never leaves the Mac, and `mkcert -uninstall` removes it.
- **Runs on Claude cost money.** Each is time-boxed and within the spend caps, and the results say what each cost.
