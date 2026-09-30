# Terms

The words we use, so docs, code, UI and commits stay consistent. Standard industry terms are not defined here; only our choices are.

| Use | Not | Meaning |
|---|---|---|
| **Software Factory**, **the factory** | dark factory | The product name, and the system in prose: agents, gates, delivery and console. Web pages are titled "Software Factory · Martin Rogan". Avoid "dark factory": it is an industry term we do not use. |
| **console** | command centre, dashboard, control panel | The factory's web UI for visitors and admin: timeline, scrubber, feed, scoreboard and controls. |
| **Kubernetes** | k8s, kube | The orchestration platform, in prose. Name a specific distribution (k3d, DOKS, EKS) only when the difference matters. |
| **stage** | step, phase | One part of the factory's line: sense, triage, plan, build, gates, review, release, verify. |
| **the line** | conveyor, workflow | The eight stages in order, and their drawing across the top of the console. "Stop the line" halts all of it. "Pipeline" means CI only. |
| **station** | node, card | The drawing of one stage on the console's line. |
| **Needs you** | inbox, approvals, queue | Work waiting on Martin, and the console panel that lists it. |
| **work item** | job, task, run | One piece of work through the line (a defect fix, injected defect, improvement or red-team attack), from its first event to its last. |
| **milestone** | stage, phase, step | One unit of the delivery plan in `PLAN/`. |
| **TypeSafe** | | The company and API that serve Jev. |
| **Jev** | classifier, LLM | TypeSafe's model for typed judgements: it answers Choice, Score and Noul questions with probabilities and never generates text. |
| **question set** | prompt | A versioned group of Jev questions, such as `triage/v1`, kept as code. |
