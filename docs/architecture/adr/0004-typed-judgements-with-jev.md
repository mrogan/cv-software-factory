# 0004: Small judgements use TypeSafe's Jev, not generative prompts

## Decision

Triage judges visitors' reports with TypeSafe's Jev model, through the gateway: their category, symptom and severity, whether they hold instructions aimed at the system, and which open ticket they repeat, as typed Choice, Score and Noul questions answered with probabilities. Routing is plain code against human-owned thresholds. The senses' own signals are not judged: a sense knows what it saw, so a table in policy gives their category and severity, and a fingerprint recognises a repeat. Later stages may adopt Jev only if triage earns its place.

## Why

Typed answers cannot carry free text, so an injected instruction in a report cannot reach the planner. That enforces guardrail 8 by the shape of the interface rather than by a prompt. The probabilities make every decision explainable in the console. Where a table will do, a model would add cost, drift and a cassette, and explain less, so Jev reads only what needs a reader: text a visitor wrote.

## Consequences

- A second model provider behind the gateway, with its own adapter, budgets and cassettes.
- Pinned model versions and an evaluation fixture set in CI; upgrades are deliberate.
- Never used where guardrail 2 applies: gates, merges, releases, canary analysis and the scoreboard.
