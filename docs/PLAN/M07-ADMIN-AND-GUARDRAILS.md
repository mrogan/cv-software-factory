# Milestone 7: Admin and guardrails

## Outcome

Martin runs the factory from the console, not from the command line or by hand in the store. He signs in with a passkey and answers what waits on him in Needs you. He also stops and starts the line, sets the autonomy level and the switches, promotes, pauses, aborts and retries a canary, chooses each agent's model and effort, sets the spend caps within what policy allows, and reads the audit log. Everything he can change, a visitor can see, drawn read-only, so the controls that make the factory safe are part of the demo.

He asks for an improvement with the "+" on Plan. It goes down the same line as a fix and ships behind a feature flag that he switches from the console in stages. Verify compares the flag's two sides before everyone gets it.

Every guardrail is proved by a test or by a drill that runs from one command, and its refusals are shown as prominently as successes. Autonomy does what the spec says: under Guarded, an untagged change merges and ships with nobody touching it, and a risk-tagged one waits for Martin. The tags come from deterministic checks on the diff, and the decision to merge is a required check, never a model's word.

The app is kept patched. A security release or a fixable vulnerability in what the app runs, and each routine update, becomes a work item of kind dependency update and goes down the same line, a security one ahead of all other waiting work. A fix its own scans show removes a Critical vulnerability merges and ships with nobody touching it. The factory's own images are watched the same way, and a finding there opens an issue and notifies Martin.

The milestone is built in four parts, each by its own orchestrating session:

- **Part A, admin:** sign-in, the access policy, the admin service and its write path, every control in spec 5.4 but the improvements and flags, alerts to Martin, and the local cluster served over HTTPS.
- **Part B, improvements and feature flags:** the "+" end to end, OpenFeature and flagd in the app, flags switched from the console in stages, and Verify comparing a flag's two sides.
- **Part C, guardrails:** every guardrail proved repeatably, the red-team harness, blocked actions in the console, approval routing by autonomy level and risk tag, and the factory run Guarded.
- **Part D, patching:** a sense for what the running images carry, dependency updates for the app down the line, and an issue and a notification for the factory's own.

Each part starts when the one before has met its criteria and its pull requests are merged. Each leaves `COMPONENTS/` and `AGENTS.md` describing what it built, so the next session starts from this file, those two and the code, and needs nothing from the session before.

## How each part is built

The part's session orchestrates with the `/implement` skill (`.claude/skills/implement`): it writes a brief for each task from this file, and a sub-agent takes each to a pull request, one at a time, its report checked before it is believed. On top of what the skill does:

- **`/security-review` on every Part A pull request,** and on any in B or C that touches sign-in, the admin service, a credential, a fence or the approval routing. Each brief says so.
- **The orchestrator does what a worker skips:**
  - a `deploy/` change that waits for an image (a new Deployment, a migration, a new setting), opened once Martin has merged the change that builds the image and the App's deploy pull request that pins it. Only the App's deploy watch opens a pin's pull request (ADR 0005);
  - a proof on the local cluster, run with the `try-the-line` skill on Claude, time-boxed and within the spend caps;
  - a drill.

  Each is in the run's summary until it is done.
- **Console designs come first.** Each new view is drawn in the mockup and the design system's README, and agreed with him before it is built. Snapshots are updated in the pinned image.
- **Work in the app's repository** (Part B's OpenFeature and flagd) goes through `/implement` too, once Part B's first step lets it take a work item there.

## Decisions

### Who may do what

- **Two roles, one table.** A visitor reads public views. Admin, Martin alone, reads everything and acts. Every route and every action is in one table in `policy/access.ts`, which CODEOWNERS gives to Martin: its role, whether it reads or writes, and, for a write, whether it needs his passkey again. The server enforces the table and refuses anything not in it. The console draws its controls from the same table, so a visitor sees every control, read-only, with what it does. A test fails when a route or an action is not in the table.
- **Visitors see the controls, not the buttons.** The "+" and every improvement's request, spec and progress; the autonomy level and the switches; each agent's model and effort; spend against the caps; the flags and their stages; the audit log; what waits on Martin and how he answered. Visitor features (milestone 8) add the few writes a visitor's key allows; this milestone has none.
- **What a visitor reads is masked at the source.** Every event's public view is written when it is appended (spec 5.1), so the audit log is open to everyone, with what a visitor wrote and anything shaped like a secret already left out. Martin's answers on holds are public, through the same redactor, except his words on a hold about a visitor's report, which stay his alone, since a paraphrase of a report would pass any redactor. A sign-in's public view says that he signed in, and never the client's address, its browser or the passkey's id.

### Signing in

- **A passkey, and nothing else.** Martin signs in with a passkey (WebAuthn, user verification required): it cannot be phished, nothing reusable is kept on the server, and it works the same on every profile. There is no password and no third party.
- **Enrolled from the command line.** `factory admin enrol` runs with a role of its own, `factory_enrol`, whose password `make` fetches and no pod holds, and which may only add codes and revoke. It prints a one-time code of 128 random bits that lasts ten minutes and allows five tries, counted across every client; Martin enters it on the console's enrolment page and makes a passkey. Enrolment is the one write that takes no session: the code is its credential, used once, and the page still checks `Origin`, accepts only `POST` and is rate-limited by client address. `policy/access.ts` gives it a role of its own, `enrolment code`, and the access tests prove it refuses a request with no code, a used one, an expired one and a sixth try. Every passkey is enrolled this way, so a signed-in session can never add one. He may hold two (a laptop and a phone). `factory admin enrol --revoke-others` is recovery: it revokes every other passkey and every session. Each passkey belongs to its host, so each profile is enrolled on its own.
- **Sessions are kept on the server.** The browser holds only a random id in a cookie named `__Host-session`, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`; the store keeps its hash. A session lasts 30 minutes from sign-in with no idle timeout, a figure in `policy/access.ts`: ASVS asks for an idle timeout, and ADR 0012 records why there is none (one admin, who signs in with a passkey and gives it again for every high-impact action). The id changes at sign-in, signing out ends it on the server, and "sign out everywhere" ends them all.
- **Every action that loosens a control, raises spend, promotes something or overrides a guardrail needs the passkey again,** given within the last five minutes, so a stolen session does none of it:
  - raising a spend cap, or a setting that raises spend (a dearer model, more effort, a larger take);
  - loosening autonomy;
  - turning auto-merge on, or auto-rollback off;
  - starting the line;
  - promoting a canary, or retrying a release that was stopped;
  - widening a flag's stage;
  - approving a hold whose cause is a guardrail: `scope`, `beyond-ticket`, `review`, `gates`, `verify`, `spend` and `merge`;
  - revoking a passkey.

  `policy/access.ts` marks each, and a test holds the spec's list and the table to each other.
- **Every write is defended against forgery:**
  - `SameSite=Strict`;
  - the `Origin` header matched exactly against the console's origin in configuration, never one derived from the request's `Host`;
  - a per-session token in a header;
  - only `POST`, never a write on `GET`.

  Admin responses are `no-store`. A strict Content Security Policy, `frame-ancestors 'none'` and HSTS are on every response. Enrolment and sign-in are rate-limited by client address. WebAuthn's expected origin and relying party come from configuration too, and the tests refuse an assertion with the wrong origin, the wrong relying party, or no user verification.
- **Forwarded headers are believed only from the proxy in front.** Traefik on `local`, and Cloudflare's tunnel on public profiles (spec 8). The client's address that the rate limits key on comes from them alone.
- **The bar is OWASP ASVS 5.0 level 2.** A ZAP baseline scan runs in CI against the console with an admin session, and its findings fail the build unless a reason is kept beside the exception. The scan signs in as a real browser would, with a virtual WebAuthn authenticator enrolled against a throwaway store, so no sign-in path made for tests ships in the image. A short threat model goes in ADR 0012. It counts the console's server among what admin trusts: it never holds a session, but it serves the script that does, so its image is guarded as the admin service's is, and the Content Security Policy is the control.

### The admin service

- **One write path, separate from the console's server.** `factory admin` runs as its own Deployment in `factory`. Traefik routes `/admin/` on the console's host to it, so the browser sees one origin, while the console's server keeps its read-only role and never holds a session or a full event. The session cookie's path is `/`, as `__Host-` requires, so Traefik strips `Cookie` from every request it sends the console's server, and a test proves the server never receives one.
- **Its database role appends Martin's commands and nothing else.** It may append its own event types (holds answered, the line stopped and started, autonomy, switches, settings, release controls, sign-ins) and read the full events Martin's views need. It reads and writes its own tables of passkeys, enrolment codes and sessions, and no other.
- **Only Martin's roles can append Martin's commands.** Every worker may append events, each with a role of its own (task 1), and the intake and the crawler handle what the internet sends, so an event saying `actor: martin` proves nothing. Row security on `events` lets only the admin service's role, and the role `make stop-the-line` and `make start-the-line` use, append the admin event types; the store stamps each event with the role that appended it (`current_user`, never the client's to set); and the line, triage and the gateway act on an admin event only when that role is one of Martin's. Workers get no grant on the passkey, code and session tables. A test of the grants proves each, and that an admin event appended by any worker's role is refused.
- **It serves Martin the full events.** A live stream of full events, the public one's twin, goes to a signed-in session, which the stream checks again every few seconds, closing as soon as the session is signed out, revoked or expired. Report text is shown to him as spec 5.3 says, inserted as text.
- **It is the one service of ours that may touch a Rollout.** It gets a Role in `website` that may patch the app's Rollout and its status, by name, for promote, pause, abort and retry. A Role names objects, not fields, so a ValidatingAdmissionPolicy refuses any change of the admin service's to the Rollout but `spec.paused` and the status fields promote, abort and retry set. `release-fences.test.ts` keeps every other service account away from the Rollout, and fails if this Role or that policy grows.
- **Every action is an event.** Martin is the actor. The public view says what he did, and the console's audit log reads it like any other event.
- **Stop the line keeps its command-line path.** `make stop-the-line` does not go through the admin service, so it works when the console does not.

### Settings within policy

- **Policy sets the bounds; Martin chooses within them.** `policy/models.ts` names the models each agent may use on each profile (Claude Haiku, Sonnet and Opus to start, and Qwen where the profile has a local model, each priced in the gateway) and the highest effort for each. The console offers an agent only the models its profile has, so a local model is one choice among them, agent by agent, and a cloud profile offers none. `policy/spend.ts` names each cap's ceiling. Martin's choice is a settings event, and the gateway reads the latest. Raising a ceiling, or adding a model, is still a pull request.
- **Settings are checked where they are read, not only where they are written.** The gateway and the line check each settings event against policy as they read it, and fall back to policy's defaults for anything outside it; zero, null and anything not a finite number are never "no cap". A test appends an out-of-policy event straight to the store and shows it has no effect.
- **A setting applies from an agent's next step,** never part-way through one, and the step records the settings it ran under.
- **The line's take settings join them.** `LINE_TAKE` and `LINE_ONLY` become settings Martin changes in the console, with the variables as their defaults for a line on the host.

### Local HTTPS

Safari drops a `Secure` cookie over plain HTTP, even on `localhost`, and passkeys need a secure context. So the local console is served over HTTPS:

- `make up` creates a local certificate authority constrained to `localhost` and `.localhost` names, with `step` (pinned in `mise.toml`; `mkcert` cannot constrain one), which the Mac trusts once, and gives Traefik one certificate for the local hosts. Anything on the Mac that reads its key can mint certificates for those names alone, never for GitHub or anything else.
- The console moves to `https://console.localhost:8443`; plain HTTP on it redirects.
- The app's own hosts stay as they are, so the traffic generator and the canary's split are untouched.

Public profiles get their certificates from Cloudflare (milestone 10).

### Alerts to Martin

- **Alertmanager gets a second receiver, Pushover,** beside the intake. Its key comes from the Keychain through `make up`, as the other keys do. Alertmanager has no NetworkPolicy today; it gets its first, which lets it reach the intake and the internet on 443 and nothing else, as Kyverno's rule does until egress by host name (#176), and lets in only Prometheus and Grafana, since anything that reaches it could silence a page. A silence is itself a security event. `make egress` covers it.
- **Four levels, routed by label:**

  | Level | For |
  |---|---|
  | Page | the console or the app down, the line stuck, a spend cap reached, a security event that loosens a guardrail or changes who can sign in |
  | Notify | a release rolled back or errored, a new hold, a security event that widens what the line does or acts on a release, a security release or fixable vulnerability in a factory image |
  | Inform | a security event that tightens, but for autonomy, or only records Martin's own use, such as signing in |
  | Dashboard only | everything else |

- **Security events come first (Part A):** a sign-in, a passkey enrolled or revoked, every action that needs the passkey again, and every change to a setting. They are counted from the stored events by a worker other than the admin service, so a compromised admin service cannot keep quiet, each count starting at zero so the first of a kind alerts too, and an alerting rule alerts on any, at its kind's level. Factory health, releases and spend follow in Part C, and its images' vulnerabilities in Part D.
- **Whether the factory is up is answered from outside it.** On public profiles, an always-firing alert goes to a dead man's switch, and an outside check watches the site and the console (milestone 10).

### Feature flags (Part B)

- **OpenFeature in the app, flagd beside it.** The app asks OpenFeature, the CNCF's standard API for flags; flagd answers. flagd runs as a Deployment of its own in `website`, not in the app's pod, so the app's pods keep no token and no route to the Kubernetes API. The app uses flagd's provider in-process: it holds a copy of the flag set, kept in step by flagd, and evaluates each request itself, so no request waits on flagd. flagd's image is admitted by digest in `website-images`, the first third-party image that copy admits.
- **The flag is defined in the change; its state is Martin's.** An improvement's pull request defines its flag in the app's code, with its default off, and the spec names it. The state of every flag lives in one `FeatureFlag` resource (OpenFeature's `core.openfeature.dev` kind), `flags` in `website`. Only its definition is installed, not OpenFeature's operator. flagd watches it through the Kubernetes API, so a change reaches the app in seconds, and a kill switch needs no deploy or rollback. flagd's watch lists the whole namespace, so its Role may read `featureflags` in `website` with no names, and writes nothing; an admission policy keeps `flags` the only one there, and refuses its deletion, since flagd keeps the last flags it read when its resource goes. Off is a change to the resource, never a deletion.
- **Argo CD makes the resource and never touches its flags.** It is in Git with no flags, made before flagd starts (flagd does not start without it). `root` gains `RespectIgnoreDifferences` and ignores the resource's flags, as the local overlay already does for the Rollout's `spec.paused`, so a merge never puts Martin's stages back. Only the admin service may change them (the same kind of Role as the Rollout's).
- **The admin service writes typed stages, never flagd's own JSON.** Each stage keeps the ones before it, and each is a fixed shape of flagd's targeting: on for the mark; then for the flags a preview names too; then, for a request the app marks as signed, flagd's `fractional` rule over the signed id, with two variants weighted by the share and the rest; then on for everyone. The share is the only parameter. The same kind of admission policy as the Rollout's allows those shapes and nothing else. A flag the resource does not name is off, by its default in the app.
- **A stale flag set fails off.** The provider keeps serving the last flag set it read while flagd is away, so a kill switch would not reach it. When the provider has been stale for a minute, the app treats every flag as off, and a test shows it.
- **A flag goes out in stages,** each one change in the console:
  1. the factory's own checks' requests, so Verify can check the change in production with nobody else seeing it. The mark is the header those checks already send (`x-unmeasured`), which the app already leaves out of its telemetry: the app's ingress strips it from every request that comes through Traefik, and the app's NetworkPolicy lets in, beside Traefik, only the probes, the crawler and the canary's journeys. So only the factory's checks can make it, and the network enforces that rather than a key. The strip is in the app's repository, so an admission rule here requires it on every route to the app. The traffic generator, which stands in for the visitors, comes through Traefik and never makes it;
  2. browsers that opt in to preview it, the preview cookie counting from this stage on and never before;
  3. a share of the traffic generator's requests, by an id it sends with each one and signs. The generator holds an Ed25519 private key in a Secret of its own, and signs the id with the time, the host, the method and the path; the app holds only the public key, accepts a signature less than a minute old for the request it was made for, and ignores an id without one. A signature is a bearer credential, so what keeps visitors out is that none ever sees one: the generator's requests go from its pod to Traefik's Service inside the cluster, on every profile, and never cross the internet or a browser. Anything that could read them inside the cluster could replay one, for that page and that minute, and the worst it does is show a feature at the share stage and add a request to the figures;
  4. everyone.

  Off is a kill switch for everyone, and beats a preview.
- **The app's flag context is Martin's.** The app's code, which the line's agents write, builds the evaluation context: it reads the mark, checks the signature and names the preview. A key the app does not hold stops a forgery, not a bypass, so that module is code-owned in the app's repository, and a change to it waits for Martin in every mode.
- **Verify compares a flag's two sides at the share stage, on the traffic generator's requests.** The factory's checks' requests are too few to judge on, and are left out of the app's telemetry, so stage 1 checks the change, the probes' journeys among them, and the share stage compares. The app writes the variant on its request log, beside the route, status and time it already writes there, and on the request's span, only for a request with a signed id, so visitors' requests are never in the figures. Verify judges flag-on against flag-off on errors and latency from those logs, with the canary's thresholds. The generator spreads its walk over enough ids that each side gets the same mix of pages and enough requests. Only one flag is at the share stage at a time, so each comparison varies one thing.
- **Stage 1 checks the change by its pictures and the journeys.** The probes are written blind, from the spec rather than the code, and none knows a new feature. So stage 1 shows the change rather than proving its criteria: the probes' journeys and the `/device` check pass with the flag on, and their pictures of the pages the spec names, from the release (off) and from stage 1 (on), are the work item's evidence. The criteria are proved by the pull request's own tests, with the flag on and off, and Martin judges the pictures when he widens. A check of an improvement's criteria written blind is not part of this milestone.
- **A canary and a share take turns.** During a canary, a flag at the share stage would split its two versions' requests too, and Verify's comparison would mix the versions. So the admin service refuses to widen a flag to the share stage while a canary is in flight, and the console says why; Verify sets aside any window a canary overlaps; and the generator's ids turn independently of the canary's split, as its walk already does, so a flag left at the share stage gives a canary's two sides the same mix. A release never waits for a flag.
- **The browser is checked at stage 1, not compared.** No visitor is kept on one side before stage 4, since that needs an id on their device, and the generator runs no browser. So what a change does in a browser (a script error, a page made unreadable) is for stage 1's journeys to check, and they must pass before the flag can widen. Once a flag is on for everyone, a regression is a ticket like any other, and the kill switch is one click.
- **Martin's commands about improvements and flags are his.** An improvement's request and every flag's stage are admin event types, appended only by Martin's roles, as Part A's are, so no worker can open an improvement or stage a flag in his name.
- **A preview is the app's own feature, and harmless.** `?preview=<flag>` sets the app's preview cookie. The console's "Preview it" link uses it during the opt-in stage. The app accepts only flag names flagd knows, never echoes the parameter, and someone who sets it by hand sees a deployed feature in their own browser only. The cookie is set only when someone asks for the preview, to give them what they asked for, so it is strictly necessary.
- **Nothing on a visitor's device that they did not ask for.** Neither the console nor the app has a cookie banner, so each keeps on a visitor's device only what is strictly necessary (PECR regulation 6, as the Data (Use and Access) Act 2025 amends it, and the ICO's guidance on storage and access). Today that is the console's `__Host-session`, once Martin signs in. Flags add the preview cookie, and nothing else: a share of visitors would need an id kept on each device, and telling them apart by address and user agent instead is turned down too, since the same rules reach it and the factory relies on none of their exemptions. Whatever pull request adds a cookie, or anything else kept on a device, adds it in the same pull request to the device gates' allow-list (the console's browser tests, and the probes' `/device` check for the app), and names it on the console's privacy page and, when it is the app's, on the app's `/privacy`. The probes' allow-list lives in this repository, so an app's cookie is allowed here, in a pull request that merges first, and the app's own pull request names it on `/privacy`.

### Autonomy (Part C)

- **Risk tags that a diff can show are worked out from it.** Deterministic checks tag a change:
  - test-loosening, when a test is deleted, skipped or weakened, as the test-integrity gate judges it (a new test, which every fix brings, is not one);
  - dependency-change, for a lockfile or a package manifest;
  - security-headers, for the header settings.

  Out-of-scope is not in a diff, since the scope fence refuses a file beyond the spec's scope before it reaches GitHub. It stays the planner's tag on the spec, and the reviewer's, held for Martin before any code is written in every mode. The planner and the reviewer may add any tag and hold the work for Martin; neither can remove one. The routing check works out the diff's tags itself, never from labels, and fails a pull request whose risk label anyone but Martin has removed.
- **Merging is decided by a required check.** A human-owned approval-routing check passes for an untagged change under Guarded, any change but `out-of-scope` under Lights-out, and anything Martin has approved. From Part D, it also passes a Critical vulnerability's fix under Guarded, as Patching (Part D) says. A release pull request waits for Martin in every mode: it publishes a version, and nothing waits on it.
- **Martin's approval is his own GitHub review of the head commit.** The App writes labels, comments and check runs, so none of them can carry his approval. The check reads his review and requires its commit to be the pull request's head, so a push after he approved fails it; a test shows that. His Needs-you card for a merge links to the pull request.
- **A deploy pull request passes only as an exact pin.** The check compares lines: only `digest:` values change, each to an image `build.yml` signed on `main` whose commit descends from the pin it replaces, so nothing else in the file can move and no pin goes backwards. It then passes under Guarded.
- **In this repository, the App merges nothing but pins unattended.** The factory's own code (its gates, its GitHub worker, the gateway, the admin service, the store's migrations and the redactor) is never merged without Martin, in any mode: any other App pull request here fails the check. The check runs from the base commit and reads CODEOWNERS from it, as the app's gates do, so a pull request cannot rewrite the check that judges it; the check's script and those paths become code-owned.
- **Every pull request of the App's that touches a path CODEOWNERS gives Martin fails the check,** but for an exact pin.
- **The App may bypass the review ruleset only.** That takes away code-owner review as the backstop for the App's pull requests, so the routing check holds code-owned paths in its place. The checks ruleset keeps no bypass, so a fault in the line still cannot merge a tagged change or touch a rule. ADR 0009 changes with it. The bypass's effect on OpenSSF Scorecard's Branch-Protection score is checked before it is made.
- **Autonomy is set in the console.** Loosening it needs the passkey again and pages Martin; tightening is immediate.
- **Required checks are GitHub Actions' alone.** `github-settings.ts` already pins every required check to the GitHub Actions integration, so the App's own check runs cannot satisfy one; the routing check is pinned the same way. Lights-out is built and proved, and never the default.

### Patching (Part D)

- **What is running is watched, not what the repositories say.** One sense, daily, reads the digests deployed: Node's security releases on the line `mise.toml` pins (Node's release index), fixable High and Critical findings in each image, and the app's Dependabot pull requests and alerts. The factory's and the app's images are scanned from the SBOMs each repository's `build.yml` attests, so nothing large is pulled. The third-party images deployed (Postgres, its exporter, the proxy's nginx, flagd) have no SBOM of ours, so they are scanned by digest, from CI's copy in GHCR where `mirror.yml` keeps one and from their own registry otherwise. A deployed image the sense cannot scan is a finding in itself, so none is left out silently.
- **Two ratings, two uses.** A finding's severity, which orders its ticket and its alert, is the higher of the scanner's rating and that of the project that published the fix. Whether a fix merges without Martin is decided by the gate's pinned scanner's rating alone: the publisher is the party whose code would merge, so its rating can hold a change, never release one.
- **A finding is a ticket like any other.** Kind dependency update, category security for a vulnerability. A fixable High or Critical takes `broken`, the top severity, so the line takes it next: it already takes the oldest open ticket of the highest severity. Work already in flight finishes first. A routine update takes `cosmetic`, behind the defects.
- **An update moves every pin of what it updates.** Node in the app is pinned in `mise.toml`, the build stage's `node:` image and the distroless runtime's digest, and the runtime's tag does not name its Node. The coder moves them together, and the app gets the factory's test that keeps them in step. A Dependabot pull request for the same update is taken up rather than opened again.
- **Dependabot's settings stay.** Its cooldowns, the `node` and `playwright` groups and the mirror's lead over them are unchanged: the speed comes from the sense, and a shorter cooldown would only bring a pull request that fails the pin test sooner.
- **A Critical vulnerability's fix merges without Martin; every other update waits for him.** Under Guarded, the routing check passes a dependency change only when all of these hold, and holds it for Martin otherwise:
  - **The scans show the fix.** The gate's pinned scanner rates the vulnerability Critical in the base's image. The change's scan still lists the same package, at or above the advisory's fixed version, with the finding gone. A finding that disappears is not a fix: the change's scan must list every package the base's does, and the Node binary, bar the versions that moved. A package removed or renamed, an alias, a tarball or git source, or a report that does not parse holds the change.
  - **Nothing new.** The change's scan finds nothing new at High or above.
  - **Only what the fix needs moves.** Every package whose resolved version changes, and every package the lockfile adds, is the one the fixed finding names or a dependency its new version requires. A group pull request, or a change that moves anything else, keeps its tag.
  - **Pins only.** The diff changes `mise.toml`'s Node, `FROM` and image digests within the same repository, and versions of packages already there, with their lockfile entries. Nothing else: never a workflow's `uses:`, and never an image from another repository.
  - **Every gate passes.**

  The fix is read from the scans, never from an advisory's or a pull request's words. The canary still guards after the merge, and Martin is notified of each such merge. Any other dependency change keeps its dependency-change tag and waits in Needs you with the lockfile change and the scan's summary. The scanner must see the Node binary itself, not only the packages, proved as task 28 is.
- **The factory is patched by Martin.** The line works only in the app's repository. A finding in a factory image opens an issue here, updated rather than opened again, that `/implement` can take as it stands: the release, its highest severity and each pin to move, the Playwright image's among them, since its tag does not name its Node either. It notifies Martin. The factory's routine updates stay Dependabot's, and reach Martin as its pull requests do.

## Part A: admin

Each task is its own pull request, in order, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above.
- No hold waits in the store: Martin closed work item 1002 on 2026-10-09 (`work-item.closed`, `no-change`). The holds answered from the console in task 12 are ones a run on the local cluster makes.

### 1. A store role for each worker (#435)

- Each worker that uses the store (triage, the line, the gateway, the probes, the crawler, the intake and the log watcher) connects as a role of its own, granted only the tables and columns it uses. The GitHub worker and the traffic generator never connect to the store, and get none. The grants say in one place what each worker may touch, and a test of each role's grants fails if one grows.
- Every worker may still append events, through a role they are all members of, so task 4's row security names Martin's roles once and refuses every worker's.
- The roles' passwords come from Secrets `make up` makes and the migrate Job sets, as the scoreboard's do, with a `make` target for a cluster made before.
- It rolls out in three steps, each a merge and a deploy: the roles, in a migration; each Deployment switched to its own Secret, once the image that migrates them is pinned; then `factory_writer`'s grants on the tables taken away, and the role with them.

### 2. Local HTTPS

- `step` in `mise.toml`; `make up` makes the local authority, constrained to `localhost` names, has the Mac trust it, and gives Traefik its certificate as a Secret. A test shows the authority refuses to sign for any other name.
- `deploy/k3d/cluster.yaml` maps `127.0.0.1:8443` to Traefik's 443. On a cluster made before this, `make up` adds the port in place (`k3d cluster edit`, which makes only the load balancer again), so the store keeps its work items; it says so where people will see it.
- The console on `https://console.localhost:8443`, with plain HTTP redirecting: its ingress in `deploy/overlays/local/`, the addresses `make up`, `make samples`, `make real-store` and `make status` print, `AGENTS.md`, the e2e tests and the `try-the-line` skill.
- `make up` on a fresh clone still works for someone who declines the trust prompt, and says what they lose.

### 3. The designs

- In the mockup and the design system's README, agreed with Martin before anything is built:
  - the bottom row (Needs you and Controls);
  - sign-in and enrolment;
  - the settings;
  - the audit log;
  - promote, pause, abort and retry on the Canary panel;
  - preview as visitor;
  - each one's read-only form for visitors.
- The README's "Not decided yet" loses what this settles.

### 4. Sign-in and the access policy

- `policy/access.ts`, and the test that every route and action is in it.
- `factory admin`: its Deployment, NetworkPolicy, Traefik route and database role, with its migration and a test of its grants. A `deploy/` change follows its image.
- The store's guard on Martin's commands: row security on `events` for the admin event types, the appending role stamped on each event, the line, triage and the gateway checking it, `factory_enrol` and the role the make targets use, and no worker's grant on the admin tables.
- Passkey enrolment and sign-in, sessions, forgery defences, headers and rate limits, as the decisions say. `factory admin enrol` and `--revoke-others`.
- Tests:
  - every write route refuses no session, an expired session, a revoked one, the wrong origin and a missing token;
  - enrolment refuses no code, a used one, an expired one and a sixth try;
  - an admin event appended by any worker's role is refused, and one with `actor: martin` from any other role is ignored;
  - the cookie's flags, and that the console's server never receives it;
  - the id changes at sign-in;
  - a WebAuthn challenge cannot be used twice, and an assertion with the wrong origin, the wrong relying party or no user verification is refused;
  - step-up is enforced on every action the table marks;
  - signing out, revoking and expiry close an open full-event stream;
  - forwarded headers from anywhere but the proxy are ignored.
- The ZAP baseline scan in CI, and ADR 0012 with the threat model.

### 5. Martin's view

- The full-event stream to a signed-in session; the console draws full events for Martin and public ones for everyone else from the same projection.
- A report's text for Martin, as spec 5.3 says.
- Preview as visitor: the public stream, served by the server, not hidden in the browser.

### 6. Needs you

- The bottom row's Needs you: one card per hold, the line's and triage's, with its cause, its evidence and what each answer does (`ANSWERS`).
- Approve, reject or answer in words, appending `hold.answered`; words on a triage hold leave it held, as `WORDS_LEAVE_HELD` says.
- For visitors, the same cards, read-only, with Martin's answers once given.

### 7. Release controls

- The admin service's Role on the app's Rollout, the admission policy that holds it to the fields its controls set, and `release-fences.test.ts` updated to allow it alone and to fail if either grows.
- Promote (to the next step, or fully), pause, abort and retry on the Canary panel, each an event with Martin as its actor. Martin's abort is `release.aborted` with `by: martin`, recorded by the control rather than inferred from time: the version before takes all the traffic, nothing failed, and it is no signal. A rollback stays the analysis's alone. A retry ends the "until Martin retries it" holds that today take a `kubectl` patch.

### 8. The line's controls

- Stop and start the line from the header, with a reason: the same events as `make stop-the-line`, and a canary in flight aborted through task 7's Role, as `scripts/abort-canaries.sh` does with Martin's own credentials. `make stop-the-line` keeps its own path.
- The autonomy level, recorded; Part C makes it route.
- The switches spec 5.4 names: agents taking new work, and auto-merge of low-risk changes, which does nothing until Part C. Auto-rollback is Part C's.
- The line's take settings, read by the line in place of its variables.

### 9. Models and spend

- The bounds in `policy/models.ts` and `policy/spend.ts`, the settings event, and the gateway reading it at an agent's next step.
- The settings page: each agent's model, from the profile's models, local ones included where it has them, its effort, and the caps; raising a cap answers a `spend` hold.
- Spend against today's caps in Controls, for everyone.

### 10. The audit log

- Every agent action, model call and admin action, newest first, filtered by actor, work item and kind; the same view for everyone, from public views.

### 11. Alerts

- Alertmanager's Pushover receiver, its key from the Keychain, and its first NetworkPolicy, with `make egress` showing it reaches the intake and the internet on 443 and nothing else.
- The routes by level, and the security events' rule, counted from the stored events outside the admin service, and Alertmanager's ingress limited to Prometheus and Grafana.
- A test alert on Martin's phone: a sign-in reaches it.

### 12. The runs

On the local cluster, on Claude, at Supervised:

- The holds a time-boxed run on the local cluster makes, at least one with a guardrail cause so step-up is proved, answered from the console, and the line acting on each answer. Nothing is seeded into the store.
- The line stopped and started from the console, and a canary paused, promoted, aborted and retried from it.
- An agent's model changed in the settings, and its next step running on the new one.
- Martin uses it all on a laptop and a phone, and approves it against `INTENT.md`.

### 13. Documentation for Part A

- `COMPONENTS/`: the console, a new admin page, the event store's roles, alerting, the gateway's settings, progressive delivery's controls, and the guardrails table.
- `AGENTS.md`: the console's address, enrolling, and Pushover's key.
- `TERMS.md`: admin, passkey, step-up, setting.
- Spec sections 5 and 8, and ADR 0012.

### Part A is done when

- [x] Every worker uses the store with a role of its own, `factory_writer` has no grant on its tables, and the test of the grants passes.
- [ ] Martin signs in with a passkey on a laptop and a phone, in Safari and Chrome, and no write succeeds without his session: the access tests and the ZAP scan pass. On the local cluster the phone is Pushover on his phone and the console's layout at phone width; using the console on the phone itself waits for the cloud (milestone 10), so this stays open (Martin, 2026-10-24).
- [x] Every hold a run on the local cluster makes is answered from the console, a guardrail's among them, and the line acts on each: a failure answered in words, and a spend hold approved with the passkey and answered again by a raised cap (2026-10-24).
- [x] Stop the line, autonomy, the switches, what the line takes, the release controls, the models and the caps are each changed from the console, recorded as events, and shown read-only to a visitor (2026-10-24): the line stopped and started from the header; autonomy, the take and both switches changed, auto-merge on with the passkey; a canary paused, resumed, aborted, retried and promoted; an agent's next step run on a changed model; a cap raised.
- [x] A sign-in reaches Martin's phone (2026-10-24), and each hold that waits for him, with its links.
- [x] The audit log shows every action, with nothing a visitor wrote in its public form.

## Part B: improvements and feature flags

Each task is its own pull request, or a few in order, each demonstrable. Work in the app's repository goes through `/implement` like the rest, and nothing it writes there, in code, commits, pull requests or replies, mentions or hints at seeded defects.

### 0. Settled before the start

- Martin has agreed the decisions above (2026-10-24).
- **`/implement` takes work in the app's repository,** the run's first pull request. A work item may name the app's repository. Its worktree lives under this checkout's `scratch/`, its worker follows the app's `AGENTS.md` and `docs/REVIEWERS.md` and runs the app's `make check`, its description is written by `/visual-pr` with the app's pull request template, and every brief for it carries the rule on seeded defects. A pull request that needs one in the other repository first says so, and the orchestrator orders them.
- **Carried from Part A:** the store (`DiskArtifacts.open()` in `packages/store/src/artifacts.ts`) and the console (`artifact()` in `apps/console/src/app.ts`) each read an artifact's size apart from opening it, so a file replaced between the two reads sends the wrong `Content-Length`. Each opens once and takes the size from the handle, in a small pull request of its own.

### 14. OpenFeature and flagd

Platform work in both repositories, each pull request in its own, in this order:

- **flagd in `website`** (here): the `FeatureFlag` resource's definition; the resource `flags`, with no flags, synced before flagd, and `root`'s `RespectIgnoreDifferences` with its flags ignored; flagd's Deployment and Service, at a release at least two weeks old, its service account, and a Role, bound to it alone, that may `get`, `list` and `watch` `featureflags` in `website` and nothing else; and the admission policy that keeps `flags` the only one and refuses its deletion. flagd's NetworkPolicy lets the app's pods reach its in-process sync and health ports alone, and lets it reach the Kubernetes API, DNS and the collector; the app's policy gains egress to those two ports. flagd's image in `website-images`' `allowed`, by digest, and in `make admission-ready`. The fences' tests: flagd's Role reads `featureflags` in `website` and writes nothing, its binding names flagd's service account alone, and only the admin service may write `flags`.
- **The mark kept here** (here): an admission rule in `website` that every route to the app uses the Middleware that strips `x-unmeasured`, whose content it fixes, with a refusals record; and a test that Traefik reads no route across namespaces.
- **The generator's id** (here): `make up` makes an Ed25519 key pair once, gives the private key to the traffic generator as a Secret, and the public key to `website` as the ConfigMap `share-key`, which an admission rule lets no one but `make up`'s user write, so a ConfigMap from the app's repository cannot replace it. The generator sends a signed id with each request, from a set of ids it keeps, and its NetworkPolicy keeps it to Traefik inside the cluster. A `make` target for a cluster made before.
- **The preview cookie allowed** (here): the probes' `/device` check gains an allow-list for the app, with the preview cookie alone, and the console's privacy page names it. It merges before the app's pull request that sets it.
- **OpenFeature in the app** (the app's repository): the server SDK and flagd's provider, in-process; `docs/REVIEWERS.md`'s "nothing new to install" names each package they bring as allowed, a change of Martin's in the same pull request. The flag context in a module of its own, code-owned in the app's `CODEOWNERS`: the mark, the flags the preview cookie names, and the id as the targeting key with the signed mark once its signature checks out. A hook of the app's own writes the variant on the request log and the span, for a request with a signed id. `?preview=<flag>` sets the cookie for a flag flagd knows, and nothing else. `/privacy` names the preview cookie, and its tests and the layout's change with it. A stale flag set for a minute turns every flag off, and a test shows it. The app's Rollout reads `share-key`.
- **Proved on the local cluster:** a flag added to `flags` by hand reaches the app in seconds, for the marked request, the preview and the share as each stage says, and changing it to off turns it off; the mark sent through Traefik is ignored; an id with a bad, old or missing signature, or one made for another page, is not in the share; flagd stopped for a minute turns every flag off; and the admission refusals are recorded.

### 15. The designs

In the mockup and the design system's README, agreed with Martin before anything is built:

- the "+" on Plan and the form it opens, and its read-only form for visitors;
- an improvement's card and sheet: its request, its spec waiting for Martin, its flag's stage, and its evidence at each stage (the pictures with the flag off and on, and the share stage's comparison);
- the flags in Controls: each flag, its stage, the step to widen it with the passkey, the kill switch, why a stage cannot be taken now (a canary in flight, another flag at the share stage), and "Preview it" during the opt-in stage;
- each one's read-only form for visitors.

The README's "Not decided yet" and its line that the "+" and the flags are Part B's lose what this settles.

### 16. Flags in the console

- The admin service's Role on `flags`, by name; the admission policy that holds the admin service's changes to the stages' shapes; the fences' tests, updated to allow it alone and to fail if either grows; and a refusals script and record beside `rollout-refusals.sh`'s.
- The stages and the kill switch in Controls, each an event with Martin as its actor (`flag.staged`), an admin event type with its migration. `policy/access.ts` gains widening, which needs the passkey again, narrowing and off, which do not. The admin service refuses the share stage while a canary is in flight or another flag is at it, and a flag no improvement's spec names.
- Widening a flag is a security event at Notify, as task 11's rule counts them, and narrowing or off at Inform.
- For visitors, the same, read-only.

### 17. Verify by variant

- The generator spreads its walk over its ids so each side of a share gets the same mix of pages and enough requests in Verify's window, and its ids turn independently of the canary's split.
- Verify for a work item shipped behind a flag, at each stage. At stage 1: the probes' journeys and the `/device` check, which Verify asks for here as the journeys gate does, pass with the mark, and the pictures of the pages the spec names, from the release and from stage 1, are its evidence; then it waits for Martin to widen. At the opt-in stage: a probe asks for the preview and the `/device` check finds the preview cookie and nothing else. At the share stage: flag-on against flag-off from the app's request logs, on errors and latency, with the canary's thresholds and enough requests on each side, setting aside any window a canary overlaps. Each judgement an event, its figures the evidence. A flag turned off at any stage closes the work item as turned off, with the reason; it is no rollback.
- A test for each: an even split judged as passing, a side with more errors or a slower tail failing, too few requests waiting, and a canary's window set aside.

### 18. The "+"

- The "+" on Plan opens the form; the admin service appends `improvement.requested`, an admin event type with its migration, in Martin's words, and the work item of kind improvement it opens. `policy/access.ts` gains the request. The line acts on an improvement only when its request came from one of Martin's roles.
- The line takes an improvement as it takes a ticket: its queue and the planner's input accept a request as well as a ticket. An improvement waits behind every open ticket, oldest first, and Martin can take one at once with Just one.
- The planner's prompt and spec template for an improvement: what it changes, its flag's name, the pages it changes, and acceptance criteria its own tests prove with the flag on and off. Its questions arrive in Needs you, and every improvement's spec is held for Martin (`spec`) before any code.
- A visitor's suggestion still leads to no work (spec 5.3: a report only ever leads to a defect fix). Martin, having read one, asks with the "+" in his own words, and the comment on `ANSWERS.suggestion` says so.

### 19. The first improvement, and the documentation

On the local cluster, on Claude:

- Dark mode, asked for with the "+": it follows the browser's own setting (`prefers-color-scheme`), with no switch of its own, since a switch would keep a choice on the visitor's device. Its spec approved, built and merged with no human code, released, shown at stage 1, previewed, compared at the share stage, and switched on for everyone. Then turned off and on again, to show the kill switch.
- Martin approves it against `INTENT.md`.

Then:

- `COMPONENTS/`: feature flags, the admin service, the traffic generator, the probes, Verify and the console.
- `AGENTS.md`: the flags on the local cluster, and the generator's key.
- `TERMS.md`: flag, stage, the mark, preview, share.
- `docs/architecture/flags.html`, which steps through the stages as planned, made true to what was built.
- Spec sections 4.2 and 7, and an ADR for flags: flagd in its own pod watching the resource, the app's in-process copy failing off, the mark kept by the network, and the generator's signed ids.

### Part B is done when

- [ ] An improvement goes from the "+" to everyone through each stage, its spec approved by Martin before any code, and no worker's role can request one or stage a flag.
- [ ] Verify compared its flag's two sides at the share stage, on the generator's requests alone, and the share stage was refused while a canary was in flight.
- [ ] Its kill switch turned it off for everyone within seconds, with no deploy or rollback, and every flag fails off a minute after flagd stops.
- [ ] Neither a visitor nor the app's own code can make the mark or join the share: the mark is ignored through Traefik, a bad, old or missing signature is out of the share, and the flag context is code-owned.
- [ ] The admission refusals for `flags`, `share-key` and the app's routes are recorded, and the fences' tests hold flagd to reading `featureflags`.
- [ ] Nothing is kept on a visitor's device but the preview cookie of one who asked for it: the device gates pass, a preview among them.

## Part C: guardrails

Outlined here, and detailed when Part B is done.

- **20. Proofs in CI.** Tests for what is true today by convention:
  - no workflow uses `pull_request_target` or a self-hosted runner;
  - the reviewer's check is not required, and no gate or merge path calls a model;
  - only the gateway mounts a model key;
  - the runners' network policies render as intended.

  The rulesets' drift check (`github-settings.ts --check`) runs on a schedule.
- **21. `make guardrails`.** One command for the proofs that need the cluster:
  - egress;
  - admission's refusals;
  - the App's refusal to write a workflow;
  - stop the line;
  - a rollback.

  Each records its result as an event with the mechanism's refusal verbatim, so the console says when each guardrail was last proved.
- **22. The red-team harness.** The attacks in spec 5.3, run by Martin from admin, each recording `attack.launched` and the refusal. It adds adversarial inputs in logs and page content for guardrail 8. Milestone 8 puts its menu in front of visitors.
- **23. Blocked actions.** `action.refused` from every mechanism: the gateway, the GitHub worker and Kyverno, beside the scope fence. A guardrails panel: each guardrail, its mechanism, its last proof and its recent refusals, and one line for those that cannot be switched off.
- **24. Approval routing.** The deterministic risk tags, worked out by the check itself; the approval-routing check, run from the base commit, pinned to GitHub Actions, reading Martin's review of the head commit and passing pins only line by line; the factory's own code and the check's script made code-owned; the App's bypass of the review ruleset (ADR 0009); and the line reading the autonomy level. A dry-run soak at Guarded, then Guarded for real.
- **25. Auto-rollback's switch.** Off leaves a failed canary paused for Martin rather than rolled back. Switching it off needs the passkey again and pages him.
- **26. Guardrail 10 as written.** Its App answers an outside issue politely. The factory reads no issue as input today, so "acts only on issues it created or Martin labelled" holds by construction; whether a label of Martin's becomes a way in beside the "+" is settled when this part is detailed.
- **27. Alerts for the factory.** Its health (a worker crash-looping, a lease stuck, the store down, Argo CD degraded), releases and spend, at their levels.

**Done when:** every guardrail has a test or a demo that runs from one command and is shown in the console; a fix goes end to end at Guarded with nobody touching it; a risk-tagged change waits in Needs you until Martin approves; and each red-team attack is stopped by its mechanism, with the refusal shown.

## Part D: patching

Outlined here, and detailed when Part C is done.

- **28. The dependency sense.** The daily read of what each deployed image carries, as Patching (Part D) says, each finding a signal. It is proved on an image it must flag: one on Node 24.22.0 shows CVE-2026-111497.
- **29. Triage of its signals.** A signal's and a ticket's shape for a dependency, since today's name an app route and fingerprint a route or a page: the image, the package, its versions and the advisory, with their event versions and upcasts. Symptom classes for a vulnerability and a routine update in `policy/triage.ts`, with their severities. The fingerprint is the package and the advisory, or the package and its new version for a routine update, so the next day's repeat counts on its ticket, and the line takes a dependency's ticket as it takes a defect's.
- **30. A dependency update down the line.** Plan writes the spec from the advisory or the release; Build moves every pin, or takes up Dependabot's pull request; the gates are the app's own, dependency review and the image scan among them; Verify scans the running image as well as running its journeys, and records the scans from before and after as the work item's evidence, the picture its card shows. The app gets the test that keeps its Node pins in step. The routing check passes a Critical fix as the decisions say, and its tests hold each of these for Martin:
  - a change that claims a fix its scans do not show;
  - a fix that also changes code;
  - a finding gone because its package was removed or aliased, or the runtime image swapped;
  - a Critical fix bundled with an unrelated bump;
  - a fix rated Critical by its publisher and High by the scanner.
- **31. The factory's images.** A finding opens or updates the issue here, and notifies Martin, at task 11's Notify level.
- **32. The run and its documentation.** At Guarded, a Critical fix for the app from the sense to verified with nobody touching it, and a routine update waiting in Needs you at the merge. `COMPONENTS/`, the spec's senses, and `AGENTS.md` for the issue.

**Done when:** a security release or fixable vulnerability in what the app runs becomes a ticket within a day of being published, goes down the line ahead of waiting work and is verified in production, merging without Martin when its scans show it fixes a Critical one; a routine update follows behind and waits for him; and a finding in a factory image opens an issue and notifies Martin's phone.

## Exit criteria

- [ ] Parts A, B, C and D's criteria are met.
- [ ] Spec 10.1's scenarios 6, 7 and 8 run on the local cluster and are shown in the console: each red-team attack stopped by its mechanism, a risk-tagged change waiting in Needs you until Martin approves, and an improvement requested, approved and shipped.
- [ ] Spec 10.3's "every guardrail has a test or demo showing it holds" is met.
- [ ] Martin has used admin mode on a laptop and a phone and approved it against the bar in `INTENT.md`.

## Out of scope

- Visitor keys, their usage view, visitor limits and the visitor budget, the injector and its menu, the red-team menu for visitors, and the report widget's text for its sender (milestone 8).
- The replay site (milestone 9).
- Public certificates, the domain, the tunnel, the outside uptime check and the dead man's switch (milestone 10).
- A/B experiments on what people prefer: with no real shoppers, there is nothing honest to measure.
- Canaries for the factory's own images.
- Stopping work in flight for a vulnerability: it goes to the front of the queue.
- The line working in the factory's own repository: Martin patches the factory from an issue.

## Risks

- **The admin service is a new way in.** It is the only write path a browser reaches. It is small, refuses by default, has its own role and Role, is reviewed for security on every change, and its tests and scan run in CI.
- **A worker could pose as Martin, or touch another's tables.** Some workers handle what the internet sends. Each has a role of its own, granted only what it uses, and row security on the admin event types, with every reader checking the appending role, keeps Martin's commands his.
- **Guarded merges into a public repository with nobody watching.** A dry-run soak comes first, the routing check rather than the line decides, the canary's rollback is the guard after the merge, and tightening autonomy is one click.
- **Flag state lives outside Git.** It is the one piece of production state Argo CD does not hold. Every change is an event, so the audit log is its history, and a flag's default in the app's code is off.
- **The mark is kept by the network, not a key.** A route to the app that forgot to strip `x-unmeasured` would let anyone see a flag at stage 1, and leave themselves out of the app's telemetry, which the header already allows today. An admission rule here requires the strip on every route to the app, and a public profile's route through the tunnel is held to the same rule.
- **A page can differ by flag.** On a public profile, a shared cache in front of the app (milestone 10) must not serve one side's page to the other, so pages are kept from shared caches there.
- **Alertmanager reaches the internet.** It is allowed out on 443 as Kyverno is, until egress by host name (#176).
- **The local authority is trusted by the Mac.** It is constrained to `localhost` names, so its key, which anything running as Martin can read, mints nothing for any other site, and removing its trust from the Keychain is one command.
- **An update can bring in what it was meant to keep out.** Dependabot's cooldowns and pnpm's day still apply, a release with weaker provenance is still refused, only a change of pins whose scans show it removes a Critical vulnerability merges without Martin, and the canary is the guard after the merge.
- **Runs on Claude cost money.** Each is time-boxed and within the spend caps, and the results say what each cost.

## Retrospective

### Part A

Written as Part A's pull requests (#498 to #590) merged, with the fixes its runs on the local cluster needed. What Part A taught, and where each lesson now lives.

**Learned on the cluster**

- Using it found what review did not. In one afternoon at the console, task 12 found five faults that every pull request's two reviews had passed: stopping the line alerted no one (#575); giving the passkey again alerted at every step-up, which told Martin nothing (#575); Haiku 4.5 refuses the effort the gateway sends, so the first step on it failed (#578); "the next few" kept counting from the first time it was chosen (#581); and a held deploy named no pull request, and said it waited for Martin before one existed (#562: #574, #576). Each was a judgement only use could make, or a fault only a real call could show.
- A model policy offers must take every parameter the gateway sends. The settings tests ran against the gateway's fake provider, which accepts any; the provider refused on the first real call. Every Claude model offered now takes an effort, and the local one is sent none (`policy/models.ts`).
- Postgres keeps time to the microsecond and JavaScript to the millisecond, and postgres.js turns every `timestamptz` parameter into a `Date`. A count "since" a moment Martin chose lost the difference, and the line could take one fewer than Martin asked for (#572: the store's clock stamps it, and the queue binds it as text; `docs/COMPONENTS/EVENT-STORE.md`).
- An OpenTelemetry gauge cannot forget a series under cumulative temporality, and temporality belongs to the reader, not the instrument: a hold's series reads 0 until the line restarts (`docs/COMPONENTS/TELEMETRY.md`, pinned by a test).
- An alert can say only what its labels carry. The per-hold alert names a work item and a pull request, an exception to closed labels that is bounded by the holds waiting (`TELEMETRY.md`, `ALERTING.md`).
- A phone cannot use the local cluster: `localhost` is the phone, and a passkey belongs to its host. On the local profile the phone is Pushover, and the console at phone width on the Mac; real use from a phone waits for a public profile (`AGENTS.md`).
- The docs said a stuck line pages Martin, and no rule did; task 13 made the docs true, and the rule is Part C's.

**How the run worked**

- Trying each task on the cluster as soon as it is deployed, with Martin at the console, finds more than proving them all at the end: the five faults above were found together, late. `/implement` now has Martin try each work item once it is synced and healthy (#590).
- Two workers at once worked wherever their files did not overlap (#574 with #575, #576 with #578).
- `/security-review` in a worktree gathers an empty diff from the main checkout, every time: the reviewer reads the worktree's own diff (#590).
- A reviewer's sub-agent sometimes reported to the orchestrator rather than its worker: reviewers report to their worker alone, and the orchestrator forwards any that stray (#590).
- A second pull request marked `Part of #n` leaves its issue open after the last merges: the orchestrator closes it, naming its pull requests and how it was proved (#590).
- Database tests queued behind one migration lock, so a loaded `make check` timed out where CI passed, and workers lost time to it: each run migrates once and gives each test a copy (#586, #588).

**Left open:** Martin's use of the console from a phone waits for a public profile, so that box stays open; the stuck alert is Part C's (task 27).
