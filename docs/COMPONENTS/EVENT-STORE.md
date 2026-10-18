# Event store

An append-only record of every step, with captured artifacts (spec 5.1). Part of the [factory plane](README.md#factory-plane).

- **v1:** one Postgres table (`packages/store`).
- **Later:** snapshots or paged history, if the event count grows.

## The table

- **Migrations** are numbered, and a hook Job applies them before the console starts.
- **Append-only.** A trigger refuses every update, delete and truncate. Appends commit in `seq` order and notify listeners.
- **Idempotent appends.** An event appended again with the same `id` and content is stored once, so a worker can retry. The same `id` with different content is refused.
- **Samples or real.** The store records once whether it holds [samples](SAMPLES.md) or real events, and numbers real work items from 1000.

## Roles

| Role | May |
|---|---|
| The factory's writer | Append and read; delete the pictures no release needs and the inbox's old repeats ([triage](TRIAGE.md#matching-an-open-ticket)) |
| The console's reader | See public views only |
| The Postgres exporter's reader | Read the statistics any role may read, and nothing of the store |

The [scoreboard](SCOREBOARD.md) has a role of its own. The exporter's ([telemetry](TELEMETRY.md#the-clusters-state-and-postgres)) is granted nothing, not even `pg_read_all_stats`, which would show it other sessions' queries, the migrations' setting of the roles' passwords among them. It may hold four connections.

## Events

Event types, their Zod schemas, public views and upcasters are `packages/events`.

- **Closing.** A work item is closed by its last `work-item.closed` or `work-item.reopened`. The store takes no event on a closed work item but its reopening and its summary, and only a closed one reopens. `lastEnd` decides this, and every query asking whether a work item is closed uses it.
- **Releases.** A release's events may be on a work item or on the line itself. A verification is always a work item's.

## Artifacts

Files named by the SHA-256 of their contents: local disk on a volume, or Spaces or S3 by profile.
