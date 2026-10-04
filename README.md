# Software Factory

[![check](https://github.com/mrogan/cv-software-factory/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/mrogan/cv-software-factory/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mrogan/cv-software-factory/badge)](https://scorecard.dev/viewer/?uri=github.com/mrogan/cv-software-factory)
[![release](https://img.shields.io/github/v/release/mrogan/cv-software-factory)](https://github.com/mrogan/cv-software-factory/releases)

AI agents and deterministic gates that look after a live web app. They notice problems, write fixes, prove the fixes are safe, ship them as canaries and check that they worked. No person writes the fixes; people own the rules.

I'm Martin Rogan. This is my portfolio: a working system you can open and judge for yourself, rather than a description of what I can do. [Why it exists and what it has to prove](docs/INTENT.md).

> [!NOTE]
> **Under construction.** Milestones 1 to 4 of 11 are done ([the plan](docs/PLAN/README.md)): the repository, the toolchain, CI, a local Kubernetes cluster with GitOps and telemetry, the app the factory will look after, the console, drawn from an append-only event store and live in the browser, and the factory's senses. Probes, a crawler, alerts on the app's objectives, a log watcher and the report widget open deduplicated tickets with evidence, and Jev triages reports through the model gateway. Nothing fixes a defect yet: the first fix lands in milestone 5, which is next.

## What it will do

The factory looks after [The World's Worst Website](https://github.com/mrogan/cv-worlds-worst-website), a small shop that is broken on purpose: its first commit already holds more than twenty defects, and nothing public says where they are. Its line has eight stages:

**Sense → Triage → Plan → Build → Gates → Review → Release → Verify**

Probes and telemetry notice a defect. Triage turns it into a ticket with evidence. A planner writes a testable spec, a coder agent writes a failing test and then the fix, and deterministic checks decide whether it can merge. Argo Rollouts ships it to a small share of traffic, compares it with the running version, and promotes or rolls back on its own. A console shows all of it, live or as a replay you can scrub through.

It is safe because of mechanisms, not because the prompts ask nicely: agents can't change the rules, can't build what ships, and can't touch production. The [guardrails](docs/SPECIFICATION.md#6-guardrails) list each one and what enforces it.

## Run it locally

You need macOS or Linux, [mise](https://mise.jdx.dev) and a container runtime ([OrbStack](https://orbstack.dev) on a Mac).

```sh
mise install     # Node, pnpm, kubectl, k3d, helm, kustomize at pinned versions
make up          # a local Kubernetes cluster; Argo CD deploys the rest from this repo
make samples     # twelve sample work items, so the console has something to show
make status      # what is running, and where to open it
make egress      # prove that only the model gateway can leave the cluster
make down        # delete the cluster; nothing is left behind
```

A store holds samples or the factory's own work, never both. `make real-store` empties it for real work: use it when you want to watch the factory find and triage defects in the app, rather than browse the samples.

The factory's workers run in the cluster too: the model gateway, triage, the intake and log watcher, and the probes and crawler that look at the app. The gateway asks Jev (TypeSafe) with a key from `TYPESAFE_API_KEY` or the macOS Keychain (`typesafe-api-key`), which `make up` hands to the cluster and writes nowhere else; with no key it replays recorded answers only. Network policies let only the gateway reach the internet.

`make` on its own lists every target. The first `make up` takes a few minutes while images download.

## How changes land

Every change is a pull request, squash-merged into `main` once the required checks pass: lint, type-check, tests and an image build. A release or deploy pull request that the factory's GitHub App opened, unchanged, skips the browser tests and, for a deploy, checks that each image it pins was built from `main` instead of building one. Actions are pinned to full commit SHAs, workflows get minimal permissions, and outside pull requests never run with secrets. The settings of this repository and the app's are applied by [one script](scripts/github-settings.ts), so they can be reviewed like code, and the app's repository calls this one's title check, CodeQL and Scorecard workflows at a pinned commit, so nothing written there can loosen them.

**Review:** a code owner's approval, given after the last push, is required on `main`, and `CODEOWNERS` names me for workflows, deployment, policy and the gates' configuration. The factory opens its own pull requests as its GitHub App, so each waits for my approval. GitHub never counts an author's own approval, and every other pull request is mine, so the repository's admin may bypass review, and only to merge a pull request: it still goes through the checks, and the merge records the bypass ([ADR 0009](docs/architecture/adr/0009-review-with-an-admin-bypass.md)).

## Read more

- [Intent](docs/INTENT.md): why this exists, and the bar everything is held to
- [Specification](docs/SPECIFICATION.md): what is being built
- [Components](docs/COMPONENTS.md): which part does what
- [Decisions](docs/architecture/adr/): the major ones, and why

[MIT licence](LICENSE)
