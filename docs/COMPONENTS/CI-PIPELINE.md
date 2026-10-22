# CI pipeline

Deterministic gates (spec 4.1). Part of the [GitHub plane](README.md#github-plane).

- **v1:** GitHub Actions on GitHub-hosted runners, with a target under 3 minutes and the jobs in parallel.
- **Later:** visual regression, performance budgets, an active DAST scan, load tests.

## The jobs

- lint and format;
- type-check;
- unit and integration tests;
- the manifests rendered;
- the app's gates ([shared gates](SHARED-GATES.md)), the journeys among them;
- the console's browser tests, and ZAP's baseline scan of the console signed in as Martin.

## ZAP's baseline scan

`make zap` runs it on the Mac, as CI's `zap` job does (`apps/console/zap/scan.ts`), against the console's server and the [admin service](ADMIN-SERVICE.md) on one origin, behind a proxy standing in for Traefik, on a throwaway store. A browser enrols a passkey through the console's enrolment page with a virtual authenticator, so it signs in as Martin's does and no image holds a way in made for tests. ZAP's baseline (its spider, then its passive rules, which read each answer and send no attack) then runs in its pinned image, with Martin's session and token on every request, reading the pages the console's script draws and the admin service's answers too (`hooks.py`).

- **Any finding fails it,** unless `apps/console/zap/rules.tsv` keeps an exception with its reason beside it; a test fails an exception with none.
- **A scan that reached nothing fails too:** it must have read the page and Martin's session, signed in.
- The report is the job's artifact, `zap-report`. ZAP's image moves by hand, so a new release's rules are read before it is taken.
- It passes into the required `browser tests` check, as the browser tests do.

## Journeys

The base's and the change's images are built and run as containers in the runner, and `factory gate journeys` runs the probes and the crawler (with axe) against both at once.

```mermaid
flowchart LR
  base[Base image] --> run[Probes and crawler, against both]
  change[Change image] --> run
  run --> check{"A check passes on the base<br>and fails on the change?"}
  check -- no --> pass([Pass])
  check -- yes --> again["Run again: only the probes that failed,<br>and the crawl only if a check of its failed"]
  again -- fails again --> fail([Fail])
  again -- passes --> pass
```

- **It fails** on a check that passes on the base and fails on the change twice.
- **A check the base could not tell about** (the crawler's trouble) is reported, not failed on.
