# Event store

An append-only record of every step, with captured artifacts (spec 5.1). Part of the [factory plane](README.md#factory-plane).

- **v1:** one Postgres table (`packages/store`).
- **Later:** snapshots or paged history, if the event count grows.

## The table

- **Migrations** are numbered, and a hook Job applies them before the console starts.
- **Append-only.** A trigger refuses every update, delete and truncate. Appends commit in `seq` order and notify listeners.
- **Idempotent appends.** An event appended again with the same `id` and content is stored once, so a worker can retry. The same `id` with different content is refused.
- **Samples or real.** The store records once whether it holds [samples](SAMPLES.md) or real events, and numbers real work items from 1000.

## The client

Every worker and the console reach the store through [postgres.js](https://github.com/porsager/postgres), made by the store's `connect()` ([`client.ts`](../../packages/store/src/client.ts)). It is chosen over node-postgres (`pg`) for what the factory leans on:

- **Queries as tagged templates.** Each value in ``sql`… ${x}` `` is sent as a bound parameter, so no query can be written that splices a value into its text.
- **Transactions** (`sql.begin`), which the event store's appends and the line's queue run in.
- **`LISTEN`**, on a connection postgres.js keeps open and reconnects itself, which wakes the line and triage when an event lands.
- **No dependencies of its own.**

What it lacks is telemetry: OpenTelemetry instruments `pg` and not postgres.js, which offers no hooks. So `connect()` times each query by wrapping the method all of postgres.js's queries run through, and counts connections by giving the client a socket of its own ([telemetry](TELEMETRY.md#what-each-client-of-the-store-sees)). Both rely on postgres.js's internals:

- **It is on a caret range, not pinned,** so its fixes arrive through Dependabot's pull requests like any other dependency's.
- **A release that changes those internals fails `make check`,** and so its pull request. The client's tests run against the Postgres image the cluster runs, and require every query, transaction, cursor and connection to be counted.

## Roles

| Role | May |
|---|---|
| The factory's writer | Append and read; delete the pictures no release needs, and the inbox's old repeats ([triage](TRIAGE.md#matching-an-open-ticket)) but no other signal, which row security refuses. No worker connects as it: each uses its own. The make targets that write to the store, and some tests, still do ([#435](https://github.com/mrogan/cv-software-factory/issues/435)) |
| Each worker's own | What that worker uses and nothing else, and append and read events through a role they share |
| The console's reader | See public views only |
| The Postgres exporter's reader | Read the statistics any role may read, and nothing of the store |

What each role may touch, table by table, column by column and, under row security, row by row, is one table, [`policy/store-grants.ts`](../../policy/store-grants.ts), and a test of the migrated store fails unless its grants and policies are exactly that table's. Each worker that uses the store (triage, the line, the gateway, the probes, the crawler, the intake and the log watcher) has a role of its own, named for it (`factory_triage` and the like), and each is a member of `factory_worker`, which may append and read events and logs in as nobody. On its own role, a worker taken over cannot touch another's tables: only the line writes its queue or ends a job's token, only the probes delete a picture, only triage says what became of a signal, and row security lets each sense send only its own signals and keep only its own looks. Any of them can still append any event. The GitHub worker and the traffic generator never connect to the store, and have no role. Each role's password is in a Secret of its own, `postgres-<worker>`, made by `make up` or, on a cluster made before, `make worker-secrets`; the migrate Job sets it.

The [scoreboard](SCOREBOARD.md) has a role of its own. The exporter's ([telemetry](TELEMETRY.md#the-clusters-state-and-postgres)) is granted nothing, not even `pg_read_all_stats`, which would show it other sessions' queries, the migrations' setting of the roles' passwords among them. It may hold four connections.

## Events

Event types, their Zod schemas, public views and upcasters are `packages/events`.

- **Closing.** A work item is closed by its last `work-item.closed` or `work-item.reopened`. The store takes no event on a closed work item but its reopening and its summary, and only a closed one reopens. `lastEnd` decides this, and every query asking whether a work item is closed uses it.
- **Releases.** A release's events may be on a work item or on the line itself. A verification is always a work item's.

## Artifacts

Files named by the SHA-256 of their contents: local disk on a volume, or Spaces or S3 by profile.
