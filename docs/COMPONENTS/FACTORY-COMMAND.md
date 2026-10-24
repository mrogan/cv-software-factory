# Factory command

`factory events load`, `play` and `export`, `factory probes`, `factory crawler`, `factory github`, `factory gate`, `factory line` and `factory traffic` (spec 5.6 names the command). Part of the [factory plane](README.md#factory-plane).

- **v1:** `apps/factory`.
- **Later:** keys, and the workers' entry points.

## What it does

- **Event logs.** It moves event-log folders in and out of the store, refusing to mix [samples](SAMPLES.md) with real events.
- **Evidence.** Its capture step (Playwright: a screenshot and where the probe looked) is how the probes keep evidence.
- **Admin.** `factory admin` runs the [admin service](ADMIN-SERVICE.md), and `factory admin enrol` prints a one-time code to enrol a passkey (`make enrol` runs it as its own role), revoking every passkey and session first with `--revoke-others`.
- **The line.** `factory line serve` runs the [line](ORCHESTRATOR.md). `factory line stop` and `factory line start` stop and start it as Martin's own role (`make stop-the-line` and `make start-the-line`, each with `REASON`), recording `--reason` if he gives one; `start` takes `--autonomy` too. The console's header does the same through the [admin service](ADMIN-SERVICE.md#stopping-and-starting-the-line).
- **Probes.** `factory probes run` runs the [probes](PROBES-AND-CRAWLER.md), and `factory probes once` prints what each check finds without writing to the inbox.
