# Milestone 3: Event store and console

## Outcome

The console becomes the console. Events stored in Postgres drive the line, the reel and the sheet the way the factory's own events will from milestone 4, with screenshots, gate results and model calls included. Playing events into the store moves an open console within a second, over server-sent events, with no refresh. The same build, fed from an event-log file with no server behind it, draws the same page: that is the replay site's mechanism (milestone 7), proved early.

Nothing real happens yet. Every work item in this milestone is a hand-written sample, and the console labels it as one.

## Decisions

- **React 19 and Vite 8, as a plain single-page app** ([ADR 0007](../architecture/adr/0007-console-in-react-and-vite.md)). The server stays TypeScript run directly by Node. The browser code is built once, in the image build and in CI. No Next.js, router, state library or CSS-in-JS.
- **The browser projects; the server stores and relays.** The server sends events and artifacts and nothing derived from them. The browser runs `project(events, t)`, which is plain TypeScript with no React in it, tested in Node. Live view and replay are the same code because the projection cannot tell where its events came from.
- **One envelope, typed payloads.** Every event is `{id, seq, ts, work_item, type, version, actor, summary, payload, artifacts, public}`. `seq` is the store's total order; `version` belongs to the event's type. Payloads are a TypeScript discriminated union, validated with Zod when an event is appended.
- **Append-only by mechanism.** The factory's writer role can insert and read. The console's role can only read. A trigger refuses every update, delete and truncate, from any role. A stored event is never rewritten; older versions are upcast when read.
- **The public view is written once, when the event is appended.** Each event type defines its own public view, and the compiler refuses a type without one. Until admin mode (milestone 8), the console serves public views only. A visitor's report text never appears in one.
- **Artifacts are content-addressed files.** Each is named by the SHA-256 of its contents and referenced from events by that hash, with its content type, size and, for a screenshot, the boxes of the elements checked. They are stored on local disk on `local`, behind an interface that Spaces and S3 will implement later. They never change, so they are cached for good.
- **Live, and resumable.** An append notifies listeners through Postgres `LISTEN`/`NOTIFY`. The console sends each event with its `seq` as the server-sent event ID, so a client that reconnects with `Last-Event-ID` gets every event it missed, once.
- **Samples say they are samples.** The event that opens a sample work item marks it as one, and the console labels its card and sheet "Sample". A store holds samples or real events, never both. Samples name no seeded defect: they show invented breakages, improvements, dependency updates and red-team attacks. Their screenshots are real captures of the app with each sample's change applied in a local scratch copy, which goes nowhere.
- **Panels arrive with what feeds them.** This milestone builds the header, the line and its stage panels, the reel and the sheet. The scoreboard and canary panel (milestone 6), Needs you and Controls (milestone 8) and Try it yourself (milestone 9) arrive with the parts that feed them, not as placeholders. A work item waiting on Martin already shows in the reel, marked Needs you.

## Tasks

### 1. The browser build

- `apps/console/web/`: `index.html`, the TSX, its own `tsconfig` (DOM types, `jsx: react-jsx`), and `vite.config.ts` with `build.assetsInlineLimit: 0`, so that no `data:` URL slips past the policy. `make check` type-checks it, and Biome lints it, accessibility rules included.
- The Dockerfile gains a build stage that runs `vite build`. The runtime image copies the output and production dependencies only.
- The server serves built files by Vite's manifest: hashed files cached for a year, the page never cached. The content security policy gains `script-src 'self'` and `connect-src 'self'`, and nothing else.
- `pnpm dev` runs Vite with hot reloading beside the Node server, proxying events and artifacts to it, under a looser policy for development only.
- `AGENTS.md`: "no build step" now applies to the server, and the browser code is built by Vite. Per-frame work (dragging, the wipe, the sheet's motion) uses refs, `style.transform` and `element.animate()`, and commits to React state when it settles.
- Port the station to a TypeScript module from the [backlog](BACKLOG.md): the same drawing, state table and reduced-motion rules, with a constructed stylesheet and SVG presentation attributes, and no `<style>` element or `style` attribute.

### 2. The event schema

In `packages/events`, shared by the console and, from milestone 4, the factory's workers:

- The envelope, and one event type for each thing a stage does: enough to drive every station state, card outcome and sheet section in the [mockup](../design/mockups/console.html). For example: a work item opened, a signal, a ticket, a spec, a pull request, a gate's result, a review, a canary step, a promotion or rollback, a verification, a return upstream, a hold for a human and its answer, and the line stopped or started.
- A model call's payload is what the gateway will log in milestone 4: agent, model, settings, input, output and cached tokens, cost, duration and cassette key. A judgement's payload is what spec section 7.2 lists: the question set and model versions, the state, and every answer with its probabilities.
- Versions and upcasters: reading an event upcasts it through each version to the current one. A test-only older version proves the chain. Until milestone 4 appends the first real event, version 1 of each type may change freely; after that, a change needs an upcaster.
- The public view for each type, with tests that report text and anything secret-shaped never reach it.
- The event-log file format: newline-delimited JSON of public events, with a folder of artifacts named by hash. Samples, recordings for the replay site (milestone 7), `make demo` and the console's tests all use it.

### 3. The event store

- An `events` table in the cluster's Postgres, with numbered SQL migrations. An Argo CD PreSync Job applies them before the console starts, and one command applies them on the host.
- The roles and the trigger in the decisions. Tests run against a real Postgres, locally and in CI, and prove each refusal: the console cannot insert, and nobody can update, delete or truncate.
- Appending validates the event, writes its public view and notifies listeners, in one transaction. An event that fails validation is refused with the reason.
- Reading returns events after a given `seq`, upcast to their current versions.

### 4. Artifacts

- A content-addressed store with a local-disk adapter, on a persistent volume in the cluster.
- The console serves `/artifacts/<hash>` with the content type recorded when the artifact was stored, never guessed, from a short list of allowed types.
- A capture script with Playwright: it opens a page of the app, takes the screenshot, records the boxes of the elements it checked and stores both. It is where milestone 4's probes start.

### 5. The samples

- About twelve work items over about five days, written in TypeScript against the event types, so the compiler checks them. They cover:
  - every kind of work item: defect fix, injected defect, improvement, dependency update, red-team attack and visitor report;
  - every outcome: verified, rolled back, held for a human, closed, needs you and in progress;
  - every picture in the design system's table, and every station state, including a return;
  - model calls on every agent, and a Jev judgement.
- One item is still in flight at the end, so the line is working when they load.
- A script exports them to event-log files. `make check` fails if the files are out of date, as it does for `tokens.css`.
- Before they merge, a script in the private repository checks them against the answer key's fingerprints and fails on any match, and Martin reads them.
- The `factory` command (spec section 5.6 already names it) starts with three subcommands:
  - `events load` appends a file's events with their times moved so the last one is now;
  - `events play` appends them at their recorded pace, sped up, so the console can be watched live;
  - `events export` writes a work item's events and artifacts to a file.
- `load` and `play` refuse a store that holds real events.

### 6. Serving events

- `GET /api/events?after=<seq>` returns public events in order. `GET /api/events/stream` sends them as server-sent events, resuming from `Last-Event-ID`, with a heartbeat so idle connections stay open. A client too slow to keep up is disconnected and resumes from where it was.
- The console connects to Postgres with its read-only role.
- Telemetry: connected clients, events sent, and the time from append to send. The console's Grafana dashboard shows all three.

### 7. The projection

- Pure functions from events and *t*:
  - each station's state, and the returns queue;
  - the reel's cards: kind, category, outcome, picture, facts and stage segments;
  - each sheet: what happened, a chapter per stage, the evidence, the change, the gates, and each agent's calls, tokens and cost with a total;
  - the header's line state.
- The design system's six rules for a station's state are a proposal until the schema lands. Confirm them, or change them in the design system's README.
- Table-driven tests in Node, one per rule. A property test checks that projecting all events at *t* equals projecting only the events up to *t*.

### 8. The console

Built from the mockup and the design system at all three widths:

- **Header:** the mark, the name and whether the line is running. The theme switch opens in Paper and doesn't remember Ink. The motion switch sits beside it.
- **The line:**
  - eight stations, each captioned with its state word and one figure;
  - returns drawn one at a time;
  - a stage panel per station, listing its items, each opening its sheet.
- **The reel:**
  - cards with every picture type, and the wipe;
  - the timeline, with days and versions;
  - dragging, flicking, the arrow keys and snapping;
  - "Play the history", which plays once on first view;
  - the "What am I looking at?" explanation.
- **The sheet:**
  - rises over the page, holds focus, and returns focus when it closes;
  - previous and next step between work items;
  - the stage scrubber, with the site's screenshot at each step;
  - the evidence, the change, the facts, agents and models, and the gates, each evidence block with its source line.
- **The states the design system leaves open:**
  - an empty store, loading and reconnecting;
  - an artifact that fails to load;
  - an event newer than the console understands.

  They are designed and agreed with Martin before they are built, and added to the design system's README.

Martin reviews in slices as they land: the line first, then a card, then the sheet.

### 9. Proof of quality

Playwright runs every check against the production build, fed from the sample files with no Postgres behind it:

- **Accessibility:** axe finds nothing on any view, in both themes, at all three widths, with motion on and off.
- **Safe by mechanism:** a listener fails the test on any content security policy violation, and on any request to another origin.
- **Visual regression:**
  - each station kind in each state, in both themes (96 images);
  - the line, one card per picture type, and the sheet, at three widths.

  Snapshots are taken in a pinned browser image, with motion off and a fixed *t*.
- **The reel's drag:** a test counts React renders during a drag; the count must not grow with the number of frames.
- **Speed:** first meaningful view within 2 seconds on a throttled phone profile, against the local cluster. The JavaScript budget is set from the first build and enforced in CI.

### 10. Deploy it locally

- `make up` creates the writer's and the console's Postgres passwords, as it already does for Postgres's own.
- Argo CD gets the migration Job and the artifacts volume.
- `make samples` loads the samples into the cluster's store.

### 11. Documentation

- Update spec section 5.1 (the envelope), `COMPONENTS.md` (the store's roles, artifacts, the console's build) and `TERMS.md` (sample, event log, projection) wherever reality differs.
- Update the design system's README for the station's status rules and the new states.
- Write an ADR only if a major decision changes.

## Exit criteria

- [ ] Martin has used the console, fed from the samples, on a laptop and a phone, in both themes and with motion off, and approved it against the bar in `INTENT.md`.
- [ ] The samples cover every kind, outcome and picture type and every station state, with a return. Every card opens a sheet with its screenshots, gates and model calls.
- [ ] Playing samples into the cluster's store moves an open console within a second, with no refresh. A test drops the stream mid-play, and the console resumes with no gap and no duplicate.
- [ ] The production build draws the same page at the same *t* from an event-log file with no server as it does live.
- [ ] Every event is validated when appended, and an invalid one is refused. An event at an older version replays through its upcaster. Tests prove that the console cannot write and that nobody can update or delete an event.
- [ ] No public view contains report text, and the samples pass the private repository's answer-key check.
- [ ] No axe findings, no policy violations and no third-party requests. Visual snapshots cover every station state in both themes, and the drag test passes.
- [ ] First meaningful view within 2 seconds on the throttled phone profile.
- [ ] On a fresh clone, `make up && make samples` gives the console showing the samples, from a CI-built image, in under 10 minutes.

## Out of scope

- Real events: sensing, triage and the gateway (milestone 4).
- The scoreboard and the canary panel (milestone 6).
- Admin mode, Needs you, Controls, Stop the line and the audit log (milestone 8).
- The replay site's build and `make demo` (milestone 7).
- Visitor keys and Try it yourself (milestones 9 and 10).
- Mirroring tickets to GitHub Issues.
- Server-side rendering.

## Risks

- **The bar is "exquisite", and the reel and the sheet are large.** The mockup sets the direction, and Martin reviews in slices. If time runs short, cut the breadth of the samples before cutting finish.
- **The schema meets real events late.** It is designed against hand-written samples, and milestone 4's events may not fit. Version 1 stays free to change until the first real event is appended; upcasters handle every change after that.
- **A sample gives a defect away.** Samples are public and show the app. Their changes are invented, the private repository checks them against the answer key, and Martin reads them.
- **A sample is taken for real work.** It is labelled on its card and sheet. The store refuses to mix samples with real events, and no public profile loads them.
- **The browser loads every event.** That is fine for hundreds. Thousands of model calls will need a snapshot or a paged history. The cost is measured in this milestone and goes to the backlog if it shows.
- **Dragging stutters through React.** ADR 0007's rule, and the test that counts renders.
- **Screenshot tests flake.** A pinned browser image, self-hosted fonts, motion off and a fixed *t*.
