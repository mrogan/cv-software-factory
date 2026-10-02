# Software Factory

[![check](https://github.com/mrogan/cv-software-factory/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/mrogan/cv-software-factory/actions/workflows/check.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/mrogan/cv-software-factory/badge)](https://scorecard.dev/viewer/?uri=github.com/mrogan/cv-software-factory)
[![release](https://img.shields.io/github/v/release/mrogan/cv-software-factory)](https://github.com/mrogan/cv-software-factory/releases)

AI agents and deterministic gates that look after a live web app. They notice problems, write fixes, prove the fixes are safe, ship them as canaries and check that they worked. No person writes the fixes; people own the rules.

I'm Martin Rogan. This is my portfolio: a working system you can open and judge for yourself, rather than a description of what I can do. [Why it exists and what it has to prove](docs/INTENT.md).

> [!NOTE]
> **Under construction.** Milestones 1 and 2 of 11 are done ([the plan](docs/PLAN/README.md)): the repository, the toolchain, CI, a local Kubernetes cluster with GitOps and telemetry, and the app the factory will look after, deployed and reporting. Nothing finds or fixes a defect yet. Next is the event store and the console; the first fix lands in milestone 5.

## What it will do

The factory looks after [The World's Worst Website](https://github.com/mrogan/cv-worlds-worst-website), a small shop that is broken on purpose: its first commit already holds more than twenty defects, and nothing public says where they are. Its line has eight stages:

**Sense → Triage → Plan → Build → Gates → Review → Release → Verify**

Probes and telemetry notice a defect. Triage turns it into a ticket with evidence. A planner writes a testable spec, a coder agent writes a failing test and then the fix, and deterministic checks decide whether it can merge. Argo Rollouts ships it to a small share of traffic, compares it with the running version, and promotes or rolls back on its own. A console shows all of it, live or as a replay you can scrub through.

It is safe because of mechanisms, not because the prompts ask nicely: agents can't change the rules, can't build what ships, and can't touch production. The [guardrails](docs/SPECIFICATION.md#6-guardrails) list each one and what enforces it.

## Run it locally

You need macOS or Linux, [mise](https://mise.jdx.dev) and a container runtime ([OrbStack](https://orbstack.dev) on a Mac).

```sh
mise install   # Node, pnpm, kubectl, k3d, helm, kustomize at pinned versions
make up        # a local Kubernetes cluster; Argo CD deploys the rest from this repo
make status    # what is running, and where to open it
make down      # delete the cluster; nothing is left behind
```

`make` on its own lists every target. The first `make up` takes a few minutes while images download.

## How changes land

Every change is a pull request, squash-merged into `main` once the required checks pass: lint, type-check, tests and an image build. Actions are pinned to full commit SHAs, workflows get minimal permissions, and outside pull requests never run with secrets. The settings of this repository and the app's are applied by [one script](scripts/github-settings.ts), so they can be reviewed like code, and the app's repository calls this one's title check, CodeQL and Scorecard workflows at a pinned commit, so nothing written there can loosen them.

**A gap, stated rather than hidden:** `CODEOWNERS` names me for workflows, deployment and policy files, but the ruleset doesn't yet require a code owner's approval. GitHub never counts an author's own approval, and until the factory has its own GitHub App identity every pull request is mine. Code-owner review is switched on in milestone 5, when the factory starts opening pull requests and I review them.

## Read more

- [Intent](docs/INTENT.md): why this exists, and the bar everything is held to
- [Specification](docs/SPECIFICATION.md): what is being built
- [Components](docs/COMPONENTS.md): which part does what
- [Decisions](docs/architecture/adr/): the major ones, and why

[MIT licence](LICENSE)
