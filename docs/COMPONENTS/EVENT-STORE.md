# Event store

An append-only record of every step, with captured artifacts (spec 5.1). Part of the [factory plane](README.md#factory-plane).

- **v1:** one Postgres table (`packages/store`).
- **Later:** snapshots or paged history, if the event count grows.

## The table

- **Migrations** are numbered, and a hook Job applies them before the console starts.
- **Append-only.** A trigger refuses every delete and truncate, and every update but one: taking the text out of a visitor's report, once it has been [kept as long as it may be](TRIAGE.md#how-long-a-report-is-kept). That changes only the payload, which stays valid at its version, and never the public view, which never had the text. Appends commit in `seq` order and notify listeners.
- **Idempotent appends.** An event appended again with the same `id` and content is stored once, so a worker can retry. The same `id` with different content is refused.
- **Samples or real.** The store records once whether it holds [samples](SAMPLES.md) or real events, and numbers real work items from 1000.

## The client

Every worker and the console reach the store through [postgres.js](https://github.com/porsager/postgres), made by the store's `connect()` ([`client.ts`](../../packages/store/src/client.ts)). It is chosen over node-postgres (`pg`) for what the factory leans on:

- **Queries as tagged templates.** Each value in ``sql`… ${x}` `` is sent as a bound parameter, so no query can be written that splices a value into its text.
- **Transactions** (`sql.begin`), which the event store's appends and the line's queue run in.
- **`LISTEN`**, on a connection postgres.js keeps open and reconnects itself, which wakes the line and triage when an event lands.
- **No dependencies of its own.**

A time to the microsecond, such as `storeClock`'s, is bound as text (``${t}::text::timestamptz``): postgres.js makes a `Date` of every `timestamptz` parameter, which keeps only milliseconds.

What it lacks is telemetry: OpenTelemetry instruments `pg` and not postgres.js, which offers no hooks. So `connect()` times each query by wrapping the method all of postgres.js's queries run through, and counts connections by giving the client a socket of its own ([telemetry](TELEMETRY.md#what-each-client-of-the-store-sees)). Both rely on postgres.js's internals:

- **It is on a caret range, not pinned,** so its fixes arrive through Dependabot's pull requests like any other dependency's.
- **A release that changes those internals fails `make check`,** and so its pull request. The client's tests run against the Postgres image the cluster runs, and require every query, transaction, cursor and connection to be counted.

## Roles

| Role | May |
|---|---|
| Each worker's own | What that worker uses and nothing else, and append and read events, but Martin's commands, through a role they share |
| Martin's command line (`factory_operator`) | Append any event, his commands among them, and read them: `make stop-the-line`, `make start-the-line` and `make samples` |
| The admin service's (`factory_admin`) | Append Martin's commands and nothing else but the opening of an improvement he asks for, numbered from the work items' sequence, read the full events, and keep the tables of signing in ([admin service](ADMIN-SERVICE.md)) |
| The enrolment's (`factory_enrol`) | Add an enrolment code, revoke passkeys and their sessions, and append the revocations; nothing else, and of the events it reads only those |
| The console's reader | See public views only |
| The Postgres exporter's reader | Read the statistics any role may read, and nothing of the store |

What each role may touch, table by table, column by column and, under row security, row by row, is one table, [`policy/store-grants.ts`](../../policy/store-grants.ts), and a test of the migrated store fails unless its grants and policies are exactly that table's. Each worker that uses the store (triage, the line, the gateway, the probes, the crawler, the intake and the log watcher) has a role of its own, named for it (`factory_triage` and the like), and each is a member of `factory_worker`, which may append and read events and logs in as nobody. On its own role, a worker taken over cannot touch another's tables: only the line writes its queue or ends a job's token, only the probes delete a picture, only triage says what became of a signal, and row security lets each sense send only its own signals and keep only its own looks. Any of them can still append any event but [Martin's commands](#martins-commands). The GitHub worker and the traffic generator never connect to the store, and have no role. No role logs in for the workers together. Each role's password is in a Secret of its own, `postgres-<worker>`, made by `make up` or, on a cluster made before, `make worker-secrets`; the migrate Job sets it.

Martin's command line has a role of its own, `factory_operator`, whose password is in `postgres-operator`, which no pod reads: the make targets that use it make it if it is not there, and set it on the role as the database's owner before they connect (`packages/store/src/operator.ts`), so they work on any cluster. On a store not yet migrated to 0023, which guards none of his commands, they connect as the database's owner instead. `make enrol` does the same for the enrolment's role, `factory_enrol`, with `postgres-enrol`, and refuses a store not yet migrated to 0025. The admin service's role, `factory_admin`, gets its password from `postgres-admin`, which `make up` makes and the migrate Job sets, as a worker's does.

The [scoreboard](SCOREBOARD.md) has a role of its own. The exporter's ([telemetry](TELEMETRY.md#the-clusters-state-and-postgres)) is granted nothing, not even `pg_read_all_stats`, which would show it other sessions' queries, the migrations' setting of the roles' passwords among them. It may hold four connections.

## Martin's commands

Every worker may append events, and some handle what the internet sends, so an event that says `actor: martin` proves nothing. His commands are the admin event types, `ADMIN_TYPES` in the events package: a hold answered, the line stopped and started, his signing in and out, his passkey given again, and his passkeys enrolled and revoked (`admin.signed-in`, `admin.signed-out`, `admin.stepped-up`, `passkey.enrolled`, `passkey.revoked`), so no worker can forge a sign-in or hide one behind a forged sign-out, his controls of the canary (`release.controlled`), so no worker can pass its abort off as his, his settings (`settings.changed`), so no worker can choose its own model or raise a cap, his controls of the line (`controls.changed`), so no worker can loosen autonomy or widen what the line takes, his stages of the feature flags (`flag.staged`), so no worker can stage a flag, and his requests for an improvement (`improvement.requested`), so no worker can set the line building something new; Verify's comparison of a flag's two sides (`flag.compared`) and its checks of a flag with the probes (`flag.checked`) are the line's, and the admin service and the line believe only the line's role's; each command the admin service adds joins them, with a migration that adds it to the store's own list (`admin_event`), and a test fails until the two agree.

- **Who appended it.** The store records on each event the role that appended it (`appended_by`), set by the database from `current_user`; an append that names any other role, or none, is refused. Events stored before it have none. The console's reader cannot see it: who appended an event is the factory's business, and the public view says who did it. Its row security shows it only the admin events the factory heeds, so the console never shows a command the factory ignored.
- **Who may.** Row security on `events` lets only Martin's roles append his commands: the admin service's, which appends nothing else but the opening of the improvement his request opens; the enrolment's, which appends the passkeys it revokes and nothing else; and his command line's. Every worker's role and the scoreboard's are refused.
- **Who opens an improvement.** An improvement widens what the line does, so only Martin's roles may open a work item of kind `improvement` (`opens_improvement` in `0035_improvement-requests.sql`), though `work-item.opened` is no command of his alone: the workers open every other kind, and the admin service none but this one, which it numbers from the store's sequence as triage does. The line acts on an improvement only when its opening and his `improvement.requested` both came from one of his roles: `flagEvents` in `packages/store` names no flag for any other, and the admin service's Just one takes none.
- **Who is heeded.** The line, triage and the gateway act on an admin event only when one of his roles appended it, or it was stored before the store recorded who did (`fromMartin` in `packages/store`). One that any other role appended is ignored, and each worker logs it once, which only a failure of row security would let happen.

### Signing in

The admin service's tables, which no worker, the console or Martin's command line may touch:

- **Enrolment codes,** kept as their SHA-256: the enrolment adds one and nothing more, and the store sets its ten minutes. Five tries at most, and used once.
- **Passkeys:** each credential's id and public key, its name, and the code it was enrolled with. At most two held at once, and a revoked one stays revoked; revoking one ends every session signed in with it, whoever revokes it.
- **Sessions,** kept as the SHA-256 of their ids: 30 minutes from signing in at most, when the passkey was last given again, and how each ended. An ended session stays ended.
- **WebAuthn's challenges,** each used once: to enrol, with its code; to sign in; or to give the passkey again, in a session.

The figures are [`policy/access.ts`](../../policy/access.ts)'s, and the grants test holds the store's to them.

## Events

Event types, their Zod schemas, public views and upcasters are `packages/events`.

- **Closing.** A work item is closed by its last `work-item.closed` or `work-item.reopened`. The store takes no event on a closed work item but its reopening, its summary, and, on one closed as turned off ([Off](RELEASE-AND-VERIFY.md#off)) or on an improvement closed as verified ([Everyone](RELEASE-AND-VERIFY.md#everyone)), its flag's own events (Martin's `flag.staged`, the line's `flag.compared` and `flag.checked`), as a flag outlives those closes; a ticket closed as verified, or a work item closed any other way, takes none; and only a closed one reopens. `lastEnd` decides this, and every query asking whether a work item is closed uses it.
- **Releases.** A release's events may be on a work item or on the line itself. A verification is always a work item's.

## Artifacts

Files named by the SHA-256 of their contents: local disk on a volume, or Spaces or S3 by profile.
