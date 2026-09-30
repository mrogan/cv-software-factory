# 0002: The console is a pure function of recorded events

## Decision

Every step of the factory is recorded as an event in an append-only store, with artifacts (diffs, metric series, log excerpts, screenshots) captured when they happen. The console renders only from events up to a time *t*. Live view and replay share the same code.

## Why

It gives the time scrubber and time-lapse replay for free, lets a static site replay real work without a backend, provides the audit log, and makes the UI testable from recorded fixtures.

## Consequences

- The UI must never read live state directly.
- Events carry a schema version with upcasters, so old recordings keep working.
- Redaction for visitors happens when an event is written.
