# Milestone 4: Sensing and triage

## Outcome

The factory notices. Five senses watch the app on the local cluster: probes walk a shopper's journeys, a crawler checks every page, Prometheus alerts on the app's objectives, a log watcher spots new errors, and reports arrive from the widget. Triage turns what they find into deduplicated tickets with evidence and screenshots, and each ticket appears in the console as a real work item: the first the factory has made itself.

Reports are judged by Jev, through the gateway, which records every call so that CI, and anyone without a key, can replay it. An evaluation set of invented reports, every red-team attack among them, proves the routing on every pull request.

Nothing is fixed yet. A ticket waits at Plan until the planner arrives in milestone 5. What this milestone is measured by is how many seeded defects the senses find with no hint, and how many tickets match no defect at all. The private repository counts both.

## Decisions

- **Senses report facts; Jev judges text.** A probe or the crawler knows what it checked: the route, the symptom class and the evidence. The ticket's category and severity follow from the symptom class by a table in code, and a repeat is recognised by its fingerprint. Jev judges only what needs a reader: a report's category, symptom and severity, whether it holds instructions aimed at the system, and which open ticket it repeats. A model where a table will do adds cost, drift and a cassette, and explains less. Jev has not been used yet, so ADR 0004 and spec section 4.1 are amended in place rather than overruled by a new ADR.
- **Signals wait in an inbox; work items start at triage.** Senses write signals to an inbox table in Postgres, the first part of the orchestrator's queue. A check that passes writes nothing. Triage takes each signal once, and only then are events written:
  - a signal with a new fingerprint opens a work item with its ticket;
  - a signal on an open ticket adds its evidence the first time each sense sees it, and after that the inbox counts it, with no event;
  - every report becomes events, because whoever sent it is owed an answer. A quarantined, parked or discarded report opens a work item that says so. A report that repeats an open ticket joins that ticket.

  So noise never reaches the reel, and the event count grows with tickets, not with the minutes a defect stays unfixed.
- **A check signals after failing twice in a row**, so a blip does not open a ticket. Tickets close only when a fix is verified (milestone 6), so a ticket opened by mistake stays open and is counted as a false positive.
- **One fingerprint, one ticket.** What the senses find is fingerprinted by route and symptom class, as the answer key is. A class the crawler finds on every page becomes one ticket for every route (`*`), not one per page. A content ticket's fingerprint is the page and a passage of its text: Jev chooses the passage from the page as the factory reads it itself, so the ticket never holds what the visitor wrote.
- **A report's text is for people, and Jev is the only machine that reads it.** The event keeps it in its private payload. Spec section 5.3 sets who may read it: Martin in admin mode (milestone 8) and the visitor whose key sent it (milestone 9), each seeing it scrubbed, and nobody else, so visitors never see each other's. No public view, committed cassette, log line, planner or coder ever carries it. A ticket from a report holds Jev's typed answers and the factory's own evidence: a screenshot of the page the report names, at its path only, because the query is the visitor's too. Email addresses and long numbers are removed before the text leaves the cluster.
- **The gateway is the only way to a model, from the first call.** A service in the `factory` namespace. It holds the TypeSafe key, and is the only pod that has it or may reach the internet. It counts spend against caps, logs every call without its state, and runs in live, record or replay mode. It calls TypeSafe with `fetch` and checks every response with Zod, rather than using TypeSafe's SDK: the gateway needs the bytes on the wire for cassettes, and must not trust a response it has not checked. The Anthropic adapter arrives with the planner (milestone 5), behind the same interface.
- **Cassettes are the only exact replay.** Jev does not promise identical answers to identical requests, so CI replays and fails on a miss. A cassette is keyed by the SHA-256 of the provider, the pinned model, the questions (with each Choice's options in their order, since order can change an answer) and the state. Committed cassettes come only from the evaluation set, whose reports are invented. Recordings of real reports stay on the cluster's volume and are never committed or published.
- **Thresholds and objectives are policy.** Triage's routing thresholds, the table from symptom class to category and severity, the app's objectives and the spend caps live in typed files under `policy/`, which CODEOWNERS gives to Martin. Prometheus's alerting rules are generated from the objectives, and `make check` fails if the generated rules are out of date, as it does for `tokens.css`.
- **Alerts the standard way.** Prometheus evaluates alerting rules on the app's request metrics, and Alertmanager, switched on, sends them by webhook to the factory's intake. The intake fetches the series behind each alert as the evidence. The rules are thresholds over short windows with a minimum number of requests, because a demo shop's traffic is thin: until the traffic generator (milestone 6), the probes and the crawler are most of it.
- **The factory watches the logs itself.** "A new error pattern" does not fit a ruler query. The log watcher reads error records from Loki, reduces each message to a pattern (numbers, identifiers and quoted values taken out), and signals a pattern not seen in the previous day. It also reads reports from Loki, where the widget's records land, and checks, per route, that the requests counted in metrics, logged and traced agree.
- **Senses run again when the app changes.** The probe service watches `/version`, and a new version runs the journeys and a crawl at once instead of waiting for the schedule. A deploy's defects reach triage within minutes, which open question 3 needs.
- **Probes are written without the answer key.** Journeys any shop should pass and a checklist any site should pass, written from the app's public pages. Nobody who writes them reads the private repository, and no check aims at one page's wording or one product. Otherwise "found without hints" (spec 10.2) means nothing.
- **Two images.** `factory`, distroless Node: the gateway, triage, the intake and log watcher, and the `factory` command. `factory-browser`, from the pinned Playwright image: the probes and the crawler. CI builds both and pins them by pull request, as it does the console (ADR 0005).
- **The store numbers work items.** A Postgres sequence, from 1000 in a real store. A ticket's number is its work item's.
- **Version 1 of the events changes for the last time.** The first real event freezes it, so task 1 lands everything this milestone needs from the schema before anything real is appended. After that, every change needs an upcaster.
- **The line can be stopped from the start.** Every worker checks for `line.stopped` before it takes work, and `make stop-the-line` appends it. The console's button arrives with admin mode (milestone 8).

## Tasks

The tasks land in this order, each as its own pull request, each demonstrable.

### 0. Settled before the start

- Martin has agreed the decisions above.
- `policy/` is in CODEOWNERS.
- Spend has one cap across every model provider: $20 a day on `local`, and $20 a day and $100 a month on the hosted profiles. Jev costs $0.042 per million input tokens and nothing for output; a triage request is a few hundred tokens, so a thousand reports cost about two cents.
- The TypeSafe key is in Martin's macOS Keychain as `typesafe-api-key`, where `make up` and the inner loop read it (task 10).

### 1. The events and the store, before the first real append

In `packages/events`:

- `not-cached` joins the symptom classes, so every answer-key entry can be matched. The private repository's CI compares its list with this package's and fails on a difference (from the backlog).
- Outcomes for the reports triage ends: quarantined and discarded, each with its reason. A parked report holds for Martin (`hold.started`) and shows as Needs you.
- `judgement.made` records the candidate tickets it was offered and, for a repeat, the ticket it joined. Its category labels and the vocabulary agree (`not_a_problem` and `not-a-defect` today).
- Evidence for what a browser sees: an HTTP exchange (status, the headers checked, timings, redirects), browser console errors, and accessibility findings with the boxes of the elements concerned.
- A spend cap reached, and cleared, as events of the line.
- The samples change to fit, and pass the private repository's check again.

In `packages/store`, migration 0002:

- The store records once whether it holds samples or real events, so an append no longer scans the table to find out.
- The work-item sequence, and the inbox (task 4).
- An event appended again with the same `id` and the same content succeeds without a second copy, so a worker can retry. The same `id` with different content is refused with the reason.

And `make real-store` replaces the local store with an empty one for real events, with a line in the README on when to use it (from the backlog). `make samples` already refuses a real store.

### 2. The gateway

In `apps/factory`:

- One internal endpoint for a judgement: the agent, the work item, the question set and the state in; the answers, cost, duration and cassette key out. Requests name a pinned model, `jev-1.13.0`, never an alias.
- The TypeSafe adapter: Zod schemas for the request and response, from TypeSafe's OpenAPI document; a timeout; retries with backoff on 429, 529 and 5xx, honouring `Retry-After`. It never logs a provider's error body, because a validation error echoes the request, report text included.
- Modes: live, record, replay, and replay falling through to record for development. CI uses replay and fails on a miss.
- Budgets: one cap across every provider, per day and per month (task 0 has the figures), and one per work item. At a cap the gateway refuses, a line event says so, triage stops taking reports, and they wait in the inbox until the cap resets. The senses' signals carry on: they call no model. The visitor budget arrives with visitor actions (milestone 9).
- Every call logged for the audit log: agent, work item, model, tokens, cost, duration, cassette and outcome, but never the state. Metrics for calls, spend and latency, on the factory's Grafana dashboard.

### 3. Jev in practice

Before the question set is fixed, a script measures what TypeSafe's documentation leaves open, through the gateway in record mode, and the findings go into `TYPESAFE.md`:

- whether identical requests get identical answers, and how far they drift if not;
- whether the order of a Choice's options moves its answer;
- whether the narrower injection question (in `TYPESAFE.md`) stops the polite feature request from reading as an attack, and what a structured description with examples does for each question;
- what a pinned version, an unknown model, a rate limit and an oversized state return;
- the tokens and time a triage request takes.

### 4. Triage

In `packages/triage`, a worker with the `factory` command as its entry point:

- **The inbox:** a Postgres table. Senses insert; triage takes each signal with `FOR UPDATE SKIP LOCKED`, woken by `NOTIFY`, with retries and a limit on attempts. A signal that keeps failing stays in the inbox with its reason, and the factory's dashboard shows it.
- **The question set `triage/v1`**, as typed TypeScript: category, symptom class, severity, injection, and which open ticket on the same page the report repeats, with "none of these". The candidates are described from their tickets' typed fields, never from another report. A report judged to be about content gets a second request, which chooses the passage from the page.
- **Routing**, a pure function of the answers and the policy, with a table-driven test for each route and each threshold: quarantine, park, discard, a new ticket, or a repeat.
- **Signals from the senses**: category and severity from the policy table, and repeats by fingerprint.
- **The events** for each outcome, with a summary written from a template over typed fields. That answers the backlog's question of who writes `work-item.summarised` for now; the story of a finished item waits for an item that finishes.
- For a report, a screenshot of the page it names, taken by the factory.

### 5. The evaluation set

- About sixty invented reports, each with its page and expected route, and a category for those that become tickets: every category, polite feature requests, chatter, a version of every red-team attack written as a report, and near-misses such as a report quoting an error message, one addressed to "the developers", and one with instructions meant for a person.
- None describes a seeded defect. The private repository checks them against the answer key, as it does the samples, and Martin reads them.
- In CI, on cassettes and with no key: every report routes as expected.
- `make eval` runs them live: it records new cassettes, and prints each answer, the margin between each deciding probability and its threshold, and any within the margin. Run several times, it shows the drift. Its results replace the spike's table in `TYPESAFE.md`.
- Each failure is sorted into one of the four causes in `TYPESAFE.md`: missing evidence, the model, routing code, or the service.

### 6. The probes

In `apps/factory`, run by the `factory-browser` image:

- Playwright journeys a shopper takes: browse, open a product, search, page through the catalogue, send the contact form. Each checks what any shop should do, compared against the app's own API where it can be: a search finds a product by a word in its name, pages cover the catalogue with no gaps or repeats, a price is a price.
- Every few minutes, and at once when `/version` changes. Each signal carries the app's version and a screenshot with the boxes of the elements checked (`capture.ts`).
- Each check is tested against a small site made in the test, once with the symptom and once without, so the probes are proved without the app or its answer key.

### 7. The crawler

- Every page and asset reachable from the home page, checked for: broken links and images, redirect loops, server errors, browser console errors, accessibility with axe, security headers, caching of static assets, response time, and what error pages give away (it asks for a missing page and sends a malformed request).
- A class found on every page crawled is one signal for `*`.
- Every few minutes and at once on a new version. Tested the same way as the probes.

### 8. Telemetry

- Prometheus alerting rules generated from `policy/`: per route, error ratio and latency against their objectives. Alertmanager on, with one receiver: the intake.
- The intake turns an alert into a signal, with the series behind it as a metric picture.
- The log watcher (decisions): new error patterns, with their lines and trace IDs; reports; and the per-route agreement of metrics, logs and traces. Traces reach Tempo a minute or two late, so a signal carries trace IDs at once and the spans when they are queryable.
- The factory's Grafana dashboard: inbox depth, signals by sense, time from signal to ticket, gateway spend.

### 9. The console

- Real work items: a ticket waiting at Plan, a quarantined report (the judgement as its picture, injection probability first), a parked report as Needs you, a discarded one, and a ticket's sheet listing each sense that saw it.
- The model row reads the provider from the event instead of assuming Anthropic.
- Triage's stage panel lists where work comes from (spec 5.2): the five senses and what each has sent.
- The new states are designed and agreed with Martin before they are built, and added to the design system's README. Snapshots are updated in the pinned image.

### 10. Deploy it locally

- `make up` creates the gateway's Secret from `TYPESAFE_API_KEY`, or failing that from the Keychain. The key is never written to a file. Without it the gateway runs in replay only, and a report with no cassette waits in the inbox, saying why.
- Argo CD gets the gateway, triage, the intake and log watcher, the probes and crawler, Alertmanager and the rules.
- The cluster's first NetworkPolicies: in `factory`, egress is denied except to DNS, Postgres, the collector, Prometheus, Loki, the app and the gateway; the gateway alone may reach TypeSafe. A test proves another pod cannot.
- Workers write artifacts to the artifacts volume; the console still mounts it read-only.
- Everything meets the restricted Pod Security Standard, Chromium included.
- `build.yml` builds both images and opens their deploy pull request.
- `AGENTS.md`: the workers run on the host in the inner loop, against forwarded Postgres, Prometheus, Loki and the gateway.

### 11. The count

In the private repository, a script reads an exported event log of tickets and prints how many seeded defects they match and how many tickets match none. It names nothing unless asked to. A content ticket matches when its passage contains the answer key's text. It runs on a fresh real store that has had no reports, after an hour of sensing, and its figures go in this file's results.

### 12. Documentation

- Spec sections 4.1 and 7.2, and ADR 0004, for the narrower use of Jev.
- `TYPESAFE.md`: what task 3 found, the question set, the evaluation results, and reports triaged from this milestone (it says milestone 9 today; that is when visitor keys arrive).
- `COMPONENTS.md`: the gateway, the inbox, the senses, alerting, the two images and the network policies. `TERMS.md`: signal, check, inbox and ticket, if the words need pinning down.
- The backlog: what this milestone leaves open.

## Exit criteria

- [x] On a fresh clone with a key, `make up && make real-store` gives a factory whose senses open tickets against the seeded app within 15 minutes, every ticket with its evidence, and a screenshot wherever there is a page to show.
- [x] With no reports, the tickets match at least 12 of the 24 seeded defects by the private repository's count. Every ticket that matches none is listed in the results, with its cause.
- [x] No seeded defect has two tickets, and a sense running again over the same defect opens nothing new.
- [x] A report sent from the widget appears in the console, triaged, within 30 seconds. Its text is in no public view, committed cassette or log line, which tests check.
- [x] Every report in the evaluation set routes as expected in CI, on cassettes with no key, and a missing cassette fails the run. Live, `make eval` agrees, and its margins are recorded. Every red-team report is quarantined and every polite feature request parked.
- [x] Only the gateway holds the key or reaches the internet, and tests show another pod cannot. At a spend cap the gateway refuses and the console says so.
- [x] A new version of the app is probed and crawled within two minutes of becoming ready.
- [x] `make stop-the-line` stops triage taking work, and starting the line again resumes from the inbox, losing nothing.
- [x] Martin has watched the factory sense and triage in the console, on a laptop and a phone, and approved it against the bar in `INTENT.md`.

## Results

The count after an hour of sensing on the local cluster, with no reports, by the private repository's `workshop/count.ts`. It ran on 3 and 4 October, on a store made empty by `make real-store`, with every fix up to #51:

| Measure | Result |
|---|---|
| Seeded defects matched | 13 of 24 |
| Tickets that match no defect | 5 of 18 |
| Defects with two or more tickets | none |
| Tickets with a screenshot | 17 of 18 (the log watcher's has no page to show) |
| First ticket | 5 minutes after the workers started; 17 tickets within 6 minutes |

Every ticket that matches no defect reports a real fault in the app; none is a check that misread a page. Each is filed under a route the answer key does not use for that fault:

| Ticket | Why it matches nothing |
|---|---|
| A page redirects without end on `/` | The probe that follows the home page's links filed the loop under the page holding the link, not the page that loops. Another ticket has the loop under its own route. |
| A page redirects without end on `/departments/:department` | The factory names the route's parameter by what it holds, and the answer key by another name. The count compares route templates exactly. |
| Images without alternative text on `/` | The same images, missing their text, on a page the answer key does not list for them. |
| Images without alternative text on `/products/:slug` | As above, on another page. |
| Files the browser may not keep on `/assets/drawings/:file` | A more specific route than the answer key's for the same files. Another ticket, on the broader route, matched. |

Two of the five come from how routes are named and attributed, not from sensing. They are [issues](https://github.com/mrogan/cv-software-factory/issues).

## Retrospective

What the milestone taught, and where each lesson now lives.

**Decided**

- Jev reads only what a visitor wrote. A sense knows what it saw, so a table in policy gives its signal a category and severity, and a fingerprint recognises a repeat. Spec sections 4.1 and 7.2, and ADR 0004, amended in place because Jev had not been used yet.
- Checks are written from the app's public pages by an author who has not read the private repository, the app's source or its tests. Otherwise "found without hints" measures nothing: spec section 4.1.
- One spend cap covers every model provider, with $2 for each work item until the planner and coder show what a fix costs: `policy/spend.ts`, and milestone 5's input.

**Learned about Jev** (all in `TYPESAFE.md`)

- A one-line description of each option moves a Choice more than anything else tried. Bare option names filed two of six faults under the wrong category; with descriptions, all six were right.
- Jev's answers drift between identical requests, so only a cassette replays exactly, and CI fails on a miss.
- TypeSafe accepts the alias `jev-latest`, so the gateway refuses aliases itself.

**Learned about the app and its telemetry**

- The app's request metrics name the path asked for, not its route, so each product page is its own series and too thin to alert on. The log watcher and the intake name the route from the log instead: an [issue](https://github.com/mrogan/cv-software-factory/issues), for milestone 6.
- A new trace reaches Tempo a minute or two late, so the agreement check reads windows that ended minutes ago, and signals carry trace IDs at once and spans later: `COMPONENTS.md` and an issue.
- Two of the five tickets that matched no defect came from how a route is named or which page a fault is filed under, not from what was sensed: issues.
- The first real report from the widget was read with the record shape the log watcher had guessed, so that backlog item is closed.

**Left open:** see the [issues](https://github.com/mrogan/cv-software-factory/issues).

## Out of scope

- The planner, the coder, the reviewer and the GitHub App (milestone 5), and with them mirroring tickets to GitHub Issues and the Anthropic adapter.
- Closing a ticket, verify, probes against a canary, and the traffic generator (milestone 6).
- Answering Needs you, and showing a report's text to Martin and its sender (milestone 8).
- Visitor keys, limits and budget (milestone 9), and the widget saying where reports go before the app is public (milestone 10).
- The Bedrock adapter (milestone 11).
- Checking content with a crawler (spec section 11).

## Risks

- **This is the largest milestone so far.** The tasks land in order, each one demonstrable. If time runs short, the telemetry agreement check goes to the backlog before anything is finished less well.
- **Thin traffic means quiet alerts.** The rules need a minimum number of requests, and the probes and crawler supply most of them. If that is not enough, the traffic generator moves forward from milestone 6.
- **Jev drifts near a threshold.** Cassettes for exact replay, margins measured by `make eval`, and thresholds kept clear of where the evaluation set's answers fall.
- **A report steers Jev's answers.** TypeSafe says Jev does not treat its state as hostile. A report can only move probabilities between labels the question defined, its text never reaches an agent, and the injection question routes it away first. At worst it opens a wrong ticket that the planner cannot make testable.
- **A probe encodes the answer key.** The rule in the decisions, generic checks, and Martin's review of every check before the count is taken.
- **Flaky checks open tickets.** Two failures in a row, stable selectors, and a false-positive count that shows the cost of each one.
- **Chromium under the restricted Pod Security Standard.** It cannot use its own sandbox without privileges the standard refuses. The pod's own fences (a non-root user, no capabilities, the network policies) carry that, and the probe pod's egress reaches only the app and Postgres.
- **The schema freezes.** Task 1 lands before anything real is appended, and is reviewed against what each sense will send.
