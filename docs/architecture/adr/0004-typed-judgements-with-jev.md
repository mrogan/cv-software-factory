# 0004: Small judgements use TypeSafe's Jev, not generative prompts

## Decision

Triage classification, deduplication and injection detection use TypeSafe's Jev model through the gateway: typed Choice, Score and Noul questions answered with probabilities. Routing is plain code against human-owned thresholds. Later stages may adopt it only if triage earns its place.

## Why

Typed answers cannot carry free text, so an injected instruction in a report cannot reach the planner. That enforces guardrail 8 by the shape of the interface rather than by a prompt. The probabilities make every decision explainable in the console. Calls are fast and cheap enough to run on every signal.

## Consequences

- A second model provider behind the gateway, with its own adapter, budgets and cassettes.
- Pinned model versions and an evaluation fixture set in CI; upgrades are deliberate.
- Never used where guardrail 2 applies: gates, merges, releases, canary analysis and the scoreboard.
