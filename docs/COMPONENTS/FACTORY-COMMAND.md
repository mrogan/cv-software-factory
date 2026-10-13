# Factory command

`factory events load`, `play` and `export`, `factory probes`, `factory crawler`, `factory github`, `factory gate`, `factory line` and `factory traffic` (spec 5.6 names the command). Part of the [factory plane](README.md#factory-plane).

- **v1:** `apps/factory`.
- **Later:** keys, and the workers' entry points.

## What it does

- **Event logs.** It moves event-log folders in and out of the store, refusing to mix [samples](SAMPLES.md) with real events.
- **Evidence.** Its capture step (Playwright: a screenshot and where the probe looked) is how the probes keep evidence.
- **Probes.** `factory probes run` runs the [probes](PROBES-AND-CRAWLER.md), and `factory probes once` prints what each check finds without writing to the inbox.
