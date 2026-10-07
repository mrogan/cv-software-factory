# Terms

The words we use, so docs, code, UI and commits stay consistent. Standard industry terms are not defined here; only our choices are.

| Use | Not | Meaning |
|---|---|---|
| **Software Factory**, **the factory** | dark factory | The product name, and the system in prose: agents, gates, delivery and console. Web pages are titled "Software Factory · Martin Rogan". Avoid "dark factory": it is an industry term we do not use. |
| **console** | command centre, dashboard, control panel | The factory's web UI for visitors and admin: the line, the reel and its sheets, scoreboard and controls. |
| **reel** | carousel, timeline, feed | The console's row of work items, one card each, oldest on the left and now on the right, scrubbed sideways to watch the app change. |
| **sheet** | drawer, modal, detail view | The panel that rises from the bottom of the console when a card in the reel is opened: one work item in full, from its stage scrubber to its model calls. |
| **human** | person, people, user | Anyone who is not an agent, as in "held for a human" or "code written by humans". Use **Martin** when it can only be him, and **visitor** for someone with a visitor key. |
| **Kubernetes** | k8s, kube | The orchestration platform, in prose. Name a specific distribution (k3d, DOKS, EKS) only when the difference matters. |
| **stage** | step, phase | One part of the factory's line: sense, triage, plan, build, gates, review, release, verify. |
| **the line** | conveyor, workflow | The eight stages in order, and their drawing across the top of the console; the line's worker (`factory line`) carries work items through them from Plan to the merge. "Stop the line" halts all of it. "Pipeline" means CI only. |
| **station** | node, card | The drawing of one stage on the console's line. |
| **Needs you** | approvals, queue | Work waiting on Martin, and the console panel that lists it. Not the inbox, which holds signals for triage. |
| **work item** | job, task, run | One piece of work through the line (a defect fix, injected defect, improvement, dependency update, red-team attack or visitor report), from its first event to its last. |
| **event** | log entry, message | One step of a work item, or of the line, as the event store keeps it: an envelope and a typed payload. |
| **public view** | redacted copy | What anyone but Martin may see of an event, written once when the event is appended. It never carries what a visitor wrote, their key, or anything shaped like a secret. |
| **event log** | dump, fixture, export | A folder holding public events as newline-delimited JSON, beside their artifacts named by hash. Samples, recordings for the replay site and the console's tests are event logs. |
| **projection** | view model, state | What the console draws, worked out from events and a time *t* by `project(events, t)`. Live view and replay are the same projection at different times. |
| **sample** | fixture, mock, demo data | A hand-written work item that shows what the console will show. Every sample says it is one; a store holds samples or real events, never both. |
| **artifact** | attachment, asset | A file captured with an event (a screenshot, a gate's output), named by the SHA-256 of its contents and never changed. |
| **milestone** | stage, phase, step | One unit of the delivery plan in `PLAN/`. |
| **the app** | the site, the shop (in factory docs) | The World's Worst Website, the web app the factory looks after. "The shop" is what the app calls itself to its visitors: Mossop's Practical Sundries. |
| **defect** | bug, issue, fault | Something wrong with the app that the factory should find and fix. A **seeded** defect was in the app's first commit; an **injected** one arrives later, through the injector. |
| **answer key** | defect list, catalogue | The private list of every seeded and injectable defect: category, difficulty, location, symptom, fingerprint and expected sense. Only the scoreboard reads it. |
| **fingerprint** | signature, ID | What identifies a defect from outside: a route and a symptom class, or, for content, a page and the exact text that is wrong. The scoreboard matches a ticket to the answer key by fingerprint alone. |
| **symptom class** | error type | One of a short closed list of ways a defect shows itself, such as `broken-link` or `slow-response`. The answer key and tickets share the list. |
| **sense** | detector, monitor | One of the five ways the factory notices a defect: probe, crawler, metrics, logs or a report. |
| **check** | test, assertion | One thing a sense looks at, such as "search finds a product by a word in its name". A check that passes writes nothing; one that fails twice in a row sends a signal. |
| **signal** | alert, finding, event | What a sense found, or a visitor reported: the route, the symptom class and the evidence. Signals wait in the inbox until triage takes them, and only those triage keeps become events. |
| **inbox** | queue, backlog | The table where signals wait for triage. Only the factory reads it, because reports are in it. |
| **ticket** | issue, bug | A defect triage has recognised, with its category, severity, fingerprint and evidence. One fingerprint, one ticket; a ticket closes only when its fix is verified. The GitHub issue the App opens when work on it starts is the ticket's issue. |
| **spec** | plan, requirements | What the planner writes for one ticket: the outcome, Given/When/Then acceptance criteria, the files that may change (its scope), risk tags and a rollout note. "Spec section 4.1" means a section of `SPECIFICATION.md`. |
| **step** | job, attempt | One agent's turn at one work item, in a runner: the planner's step, the coder's second round. A stage may take several steps, and a step that fails runs again as a new one. |
| **round** | iteration, loop | One pass from the coder to the gates and review. Failing gates or a review's blocking findings send the work back to the coder for the next round, as many times as the line allows before it holds. |
| **runner** | sandbox, container, agent | Where a step runs: a Kubernetes Job that checks out the repository, then one that runs the agent and reaches only the gateway and the handback, with a job token as its only credential. GitHub's are always "GitHub-hosted runners". |
| **handback** | result, callback, response | What a runner sends the line when its step ends: the patch, the agent's note, its turns and session, and the result the step asked for. Also the line's endpoint that takes it. |
| **patch** | diff, commit | The change a coder hands back, as data: everything changed since the step's commit. The GitHub worker commits it outside the sandbox. "Diff" is what a pull request shows. |
| **scope fence** | path check, allow-list | The deterministic check that refuses a patch changing a file outside its spec's scope, or under `.github/` or `deploy/`, or one a CODEOWNERS file gives a person. |
| **gate** | check, CI, test | A deterministic check a change must pass before it can merge: a required check on `main`, such as tests, test integrity or journeys. A model is never a gate: the reviewer's check run is a signal. **Gates** is also the stage that waits for them. A sense's **check** is something else. |
| **journeys gate** | e2e tests, smoke test | The gate that runs the probes and the crawler against the base's app and the change's, and fails only on a check that passes on the base and fails on the change. The app is broken on purpose, so judged alone every change would fail. |
| **hold** | block, pause, escalation | A work item waiting for Martin, with a cause (the scope fence, the gates, the review, a merge, the spend cap and others) that says what each of his answers does. Holds are what **Needs you** lists. |
| **dry run** | simulation, mock mode | The GitHub worker writing what it would have done to the artifact store and touching nothing in GitHub, while answering for its own pull requests: their checks pass, and they merge a while after they are readied, so a line in `dry-run` goes round. |
| **soak** | load test, burn-in | The line left running unattended on the local model, with the GitHub worker in a dry run, and read the morning after (`factory line soak-check`): no lease stuck, no runner left, every event valid, nothing spent. |
| **seeded baseline** | initial state, golden copy | The app's tree as first published: the correct app with every seeded defect applied. Reset restores it. |
| **TypeSafe** | | The company and API that serve Jev. |
| **Jev** | classifier, LLM | TypeSafe's model for typed judgements: it answers Choice, Score and Noul questions with probabilities and never generates text. |
| **question set** | prompt | A versioned group of Jev questions, such as `triage/v1`, kept as code. |
| **cassette** | recording, tape, mock | One model call as the gateway recorded it: the request and the provider's response, in a file named by the SHA-256 of the provider, model and request. Replaying it answers the same request again without calling the model. "Recording" means an event log. |
| **bench** | harness, playground, test rig | One agent's step run on a developer's machine against a gateway on the host, on a fixture of invented work, to work on that agent's prompt (`factory line bench`): on Qwen for nothing, on Claude to record cassettes, then from the cassettes. It runs the runner's own steps, without the runner's fence. |
