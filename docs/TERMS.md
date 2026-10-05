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
| **the line** | conveyor, workflow | The eight stages in order, and their drawing across the top of the console. "Stop the line" halts all of it. "Pipeline" means CI only. |
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
| **ticket** | issue, bug | A defect triage has recognised, with its category, severity, fingerprint and evidence. One fingerprint, one ticket; a ticket closes only when its fix is verified. |
| **seeded baseline** | initial state, golden copy | The app's tree as first published: the correct app with every seeded defect applied. Reset restores it. |
| **TypeSafe** | | The company and API that serve Jev. |
| **Jev** | classifier, LLM | TypeSafe's model for typed judgements: it answers Choice, Score and Noul questions with probabilities and never generates text. |
| **question set** | prompt | A versioned group of Jev questions, such as `triage/v1`, kept as code. |
| **cassette** | recording, tape, mock | One model call as the gateway recorded it: the request and the provider's response, in a file named by the SHA-256 of the provider, model and request. Replaying it answers the same request again without calling the model. "Recording" means an event log. |
| **bench** | harness, playground, test rig | One agent's step run on a developer's machine against a gateway on the host, on a fixture of invented work, to work on that agent's prompt (`factory line bench`): on Qwen for nothing, on Claude to record cassettes, then from the cassettes. It runs the runner's own steps, without the runner's fence. |
