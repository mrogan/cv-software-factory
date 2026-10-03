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
| **Needs you** | inbox, approvals, queue | Work waiting on Martin, and the console panel that lists it. |
| **work item** | job, task, run | One piece of work through the line (a defect fix, injected defect, improvement or red-team attack), from its first event to its last. |
| **milestone** | stage, phase, step | One unit of the delivery plan in `PLAN/`. |
| **the app** | the site, the shop (in factory docs) | The World's Worst Website, the web app the factory looks after. "The shop" is what the app calls itself to its visitors: Mossop's Practical Sundries. |
| **defect** | bug, issue, fault | Something wrong with the app that the factory should find and fix. A **seeded** defect was in the app's first commit; an **injected** one arrives later, through the injector. |
| **answer key** | defect list, catalogue | The private list of every seeded and injectable defect: category, difficulty, location, symptom, fingerprint and expected sense. Only the scoreboard reads it. |
| **fingerprint** | signature, ID | What identifies a defect from outside: a route and a symptom class, or, for content, a page and the exact text that is wrong. The scoreboard matches a ticket to the answer key by fingerprint alone. |
| **symptom class** | error type | One of a short closed list of ways a defect shows itself, such as `broken-link` or `slow-response`. The answer key and tickets share the list. |
| **sense** | detector, monitor | One of the five ways the factory notices a defect: probe, crawler, metrics, logs or a report. |
| **seeded baseline** | initial state, golden copy | The app's tree as first published: the correct app with every seeded defect applied. Reset restores it. |
| **TypeSafe** | | The company and API that serve Jev. |
| **Jev** | classifier, LLM | TypeSafe's model for typed judgements: it answers Choice, Score and Noul questions with probabilities and never generates text. |
| **question set** | prompt | A versioned group of Jev questions, such as `triage/v1`, kept as code. |
