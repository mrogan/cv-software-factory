# Console

The UI for visitors and admin (spec 5). Part of the [factory plane](README.md#factory-plane).

- **v1:** a React 19 single-page app built by Vite 8 (ADR 0007) in its own image stage.

## The server

The Node server serves:

- the build, by Vite's manifest;
- the public events, as JSON and as server-sent events resuming from `Last-Event-ID`;
- the artifacts public events refer to.

## The browser

- **It projects.** `project(events, t)` is plain TypeScript, so live and replay are the same code.
- **Replay.** The same build, fed from an event-log folder, is the replay site.

## What the image holds

Neither the factory's code nor the app's repository.

- What the projection shares with the line (its limits, how a scope matches a path, a return's words) is in `@software-factory/events`, which both read.
- A spend hold carries its cap.
- The app's reviewing rules are the one copy it keeps.

## What it draws

Everything it draws is the design system's (`docs/design/system`):

- **The line.**
- **The Canary panel**, full width under the line:
  - draws the newest release from its events, one to a `release` id;
  - shows the steps `release.started` recorded, each step's measures against the baseline, and how it ended: promoted, rolled back, stopped with the line or aborted by Martin (`release.aborted`; a history from before the line recorded aborts has only `line.stopped` after a release with no end, read as Stop the line's);
  - folds to one line 15 minutes after the release ends.
- **The scoreboard**, from the latest `score.updated` ([scoreboard](SCOREBOARD.md)).
- **The reel**, whose timeline marks each ended release's version, struck through when it was not promoted.
- **The sheet**, with:
  - for a ticket, each sense that saw it, and the later versions it saw it in again;
  - a Release and Verify section, one block per release that carried the work item;
  - a scrubber with a chapter per release, and each pass after the first folded to one.
