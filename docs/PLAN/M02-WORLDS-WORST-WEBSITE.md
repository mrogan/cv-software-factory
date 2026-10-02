# Milestone 2: The World's Worst Website

## Outcome

The factory has something to look after. `cv-worlds-worst-website` is public: a small, funny shop whose history starts from one clean commit that already contains at least 20 defects, with nothing in it that says where they are. Argo CD deploys it to the local cluster beside the console, its traces, metrics and logs appear in Grafana, and a "Report a problem" widget sits on every page.

The answer key is in `cv-software-factory-private`, and every entry in it is proved by a test: the defect is there, and it shows the symptom the key says it does.

Nothing finds or fixes a defect yet. This milestone builds the patient.

## Decisions

- **An earnest bad shop.** A small shop run with total sincerity and no skill, selling slightly useless things. The comedy is in the copy, and the defects read as honest mistakes. A deliberately ugly site would blur what counts as a defect, most of all for contrast and accessibility.
- **A correct app, then one patch per defect.** The app is written correctly, with full tests, in the private repository. Each defect is a small patch kept beside it. The public first commit is the correct app with every patch applied. So each defect is known exactly, can be proved alone, and can be put back later: the same patches become the injector's catalogue (milestone 9) and the baseline that reset restores (milestone 10).
- **The defects are listed nowhere public.** Not in this file, a commit message, a pull request or an issue in either public repository. This plan says how many and what kinds; the private repository says which.
- **The private repository publishes once.** After the first commit, the app lives in its public repository and changes there like any other code. The private repository keeps the correct app, the patches and the baseline they produced.
- **Products live in SQLite inside the image.** Node's built-in `node:sqlite`, seeded at build time and read-only at runtime. The slow queries are real queries, there is no dependency, service or secret, and two versions run side by side because each carries its own data.
- **A report is a log record.** The widget posts to the app's own `/api/reports`, which emits one structured OpenTelemetry log record. The app holds no credential and does not know the factory exists; sensing reads reports from Loki in milestone 4.
- **The app is built like the console.** TypeScript run directly by Node 24, pages rendered on the server, a few lines of script in the browser, and no framework.
- **The app's repository can deploy only the app.** It gets its own Argo CD project: namespaced resources, in the `website` namespace, and nothing else. Agents will write to that repository from milestone 5, and this is the fence around what a change there can reach.

## Tasks

### 1. The workshop

In `cv-software-factory-private`:

- `website/`: the correct app and its tests.
- `defects/<id>/`: one directory per defect, holding its patch, its answer-key entry and its detector (task 6).
- `publish`: a script that applies every patch to the correct app and writes the result to a directory. That directory is the public repository's first commit, byte for byte.
- CI that runs the proofs in task 6 on every pull request.

The same toolchain as here: `mise.toml`, pnpm, Biome, Vitest.

### 2. The shop

A one-page brief first: the shop's name, its proprietor, what it sells and how it talks. Martin approves the brief before any page is written, because every page is written from it.

Then the correct app: home, product list with pagination, product detail, search, about and a contact form, over a small JSON API. About 30 products. The contact form validates and thanks the sender; it stores and sends nothing.

`/health` and `/version` (the commit), as on the console. No real user data, no secrets, safe to put on the internet.

### 3. Telemetry

The OpenTelemetry SDK, sending to the cluster's collector: a trace per request with a span per query, request rate, errors and latency per route, and structured logs carrying the trace ID. Every signal carries the version, so a canary and its baseline can be told apart in milestone 6.

### 4. Report a problem

A widget on every page: one text field, and the page it was sent from. `/api/reports` caps the length, limits the rate, and emits the log record. Report text is untrusted: it is never rendered back, on any page, to anyone.

### 5. The defects

At least 20, and about 24 so that the set survives a few being cut. All eight categories in spec section 3.1, a spread of easy and hard, and most of them visible on screen.

Rules every defect keeps:

- **Fixable alone.** A small change in a few files, independent of every other defect. Fixing one neither fixes nor uncovers another.
- **Benign.** A missing header or a talkative error page, never a way in. No vulnerable dependency.
- **Out of the way of the line.** No defect touches `/health`, `/version`, the report endpoint or start-up, or stops telemetry leaving the pod. The factory has to be able to deploy, compare and hear about a broken app.
- **Unannounced.** No name, comment, test or TODO in the published tree hints at it. The patch removes any test the defect would fail.

### 6. The answer key, proved

Each defect's entry: category, difficulty, location, symptom, fingerprint (route and symptom class, or page and text span for content), and which sense is expected to notice it: probe, crawler, metrics, logs or a report. Symptom classes come from a short closed list, which milestone 4's tickets will share so the scoreboard can match without judgement.

Each defect's detector is a test that asserts its fingerprint. CI in the private repository proves:

- the correct app passes its own tests and trips no detector;
- each patch, applied alone, trips its own detector and no other;
- every patch applied together gives a tree that trips every detector and still passes its own `check`;
- fingerprints are unique;
- the published tree contains nothing from the answer key: no defect ID, no private path, and none of a list of words that would give the game away.

### 7. Gates the two repositories share

In this repository, from the backlog:

- The title check, CodeQL and Scorecard become reusable workflows (`workflow_call`). The app's repository calls them at a pinned SHA, so they cannot drift and stay out of reach of agents writing there.
- `scripts/github-settings.ts` takes a repository and its required checks, and applies the same ruleset and security settings to both.

### 8. The app's repository, as a tree

Everything the public repository needs is part of what `publish` writes, so it is all in the first commit:

- A README for a hiring manager: this shop is bad on purpose, the factory is what fixes it, and here is where to watch. It says defects are seeded. It does not say which.
- `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`, `CODEOWNERS`, issue and pull request templates, a dev container, `lefthook.yml`, `biome.json` and `.editorconfig`.
- Its own `check` (lint, types, tests, rendered manifests) and `build` (image to GHCR by digest, then the deploy pull request, as ADR 0005 describes). Dependabot and release-please.
- `deploy/`: a Deployment, Service and ingress for `website.localhost`, under the restricted Pod Security Standard, with a Kustomize overlay for `local` and the image pin in a file of its own.

### 9. Publish

Making a repository public cannot be taken back, so it is rehearsed and it is Martin's call.

1. Rehearse: `publish` to a directory, then run its `check` and build its image, locally and in the private repository's CI.
2. Martin reads the tree as a stranger would, looking for anything that gives a defect away.
3. Create `mrogan/cv-worlds-worst-website`, push the tree as one signed commit, apply the settings script, and make the GHCR package public.
4. Tag the published baseline in the private repository.

The first build opens the first deploy pull request. From then on, anything the public repository needs is an ordinary pull request there.

### 10. Deploy it locally

In this repository:

- The `website` namespace, the app's Argo CD project and an Application that points at the `local` overlay in the app's repository.
- A Grafana dashboard for the app. It lives here, because watching the app is the factory's job.
- `make status` shows the app's address and version.
- `make up REVISION=<branch>` points the root Application at a branch, so a `deploy/` change can be tried before it merges (from the backlog).

### 11. Documentation

Update the spec, `COMPONENTS.md`, `TERMS.md` (answer key, fingerprint, seeded baseline) and this repository's README wherever reality differs. Write an ADR for the correct-app-and-patches decision: it shapes the scoreboard, the injector and reset.

## Exit criteria

- [ ] Martin has read every page of the shop and approved it: it is funny, and it is bad in the ways intended and no others.
- [ ] The answer key holds at least 20 defects across at least six categories, each with a unique fingerprint, and the private repository's CI proves every one (task 6).
- [ ] `cv-worlds-worst-website` is public, its history starts from one commit, its CI is green, and it has the same ruleset and security settings as this repository, with the shared workflows called at a pinned SHA.
- [ ] Nothing in either public repository names or hints at a defect.
- [ ] On a fresh clone, `make up` still finishes in under 10 minutes and the app answers at `http://website.localhost:8080`, deployed by Argo CD from a CI-built image; `/version` shows the commit.
- [ ] The app's traces, per-route metrics and logs are in Grafana, and during a deploy the old and new versions can be told apart.
- [ ] A report sent from the widget appears in Loki as one structured record.
- [ ] The app's first Scorecard result is recorded.

## Out of scope

Probes, the crawler and anything else that finds a defect; e2e journeys and the other CI gates in the app's repository (milestone 5); image signing, Argo Rollouts and the canary (milestone 6); the scoreboard service; the injector and its menu; reset.

## Risks

- **The answer key leaks.** Publishing is one-way, and a fork or a cache outlives a deletion. The tree is built by a script, checked by CI for giveaways, and read by Martin before it goes public.
- **The defects turn out wrong for the factory.** Sensing does not exist yet, so whether a defect can be noticed is a judgement until milestone 4. Each entry records which sense should notice it, and the set is spread across all five. The first commit cannot be changed afterwards; a defect added later arrives as a pull request, through the injector.
- **Funny is hard.** The brief is approved before the pages are written. If time runs short, cut pages and defects before cutting the quality of what remains.
- **Patches rot against each other.** Twenty-four patches over one small app will collide. CI applies each alone and all together on every change.
