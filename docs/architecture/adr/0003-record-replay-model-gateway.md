# 0003: The model gateway records and replays responses

## Decision

All model calls go through one in-house gateway with three modes: live, record and replay. Recorded responses are stored as cassettes keyed by a hash of model, messages and tools.

## Why

Development loops become fast and cheap, tests become repeatable, and anyone who clones the repo can run the full loop with `make demo` without an API key.

## Consequences

- Changing a prompt invalidates its cassettes. Development falls through to record on a miss; CI fails on a miss.
- Cassettes are public, so they must never contain secrets. The gateway redacts before writing.
