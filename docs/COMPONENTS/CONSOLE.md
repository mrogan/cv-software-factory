# Console

The UI for visitors and admin (spec 5). Part of the [factory plane](README.md#factory-plane).

- **v1:** a single-page app written to React's API and run by Preact, built by Vite 8 (ADR 0007) in its own image stage.

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

- **The line**, with each work item at the stage its events place it in. The line writes no event as it starts to verify, so a release's promotion places the work it carries at Verify, where the line puts it then; its row there says so ("Promoted · verifying", or in a dry run, or found live) until a sense has looked.
- **The Canary panel**, full width under the line:
  - draws the newest release from its events, one to a `release` id;
  - shows the steps `release.started` recorded, each step's measures against the baseline, and how it ended: promoted, rolled back, stopped by an analysis error (`release.errored`, with the analysis's words), stopped with the line or aborted by Martin (`release.aborted`; a history from before the line recorded aborts has only `line.stopped` after a release with no end, read as Stop the line's);
  - folds to one line 15 minutes after the release ends.
- **The scoreboard**, from the latest `score.updated` ([scoreboard](SCOREBOARD.md)).
- **The reel**, whose timeline marks each ended release's version, struck through when it was not promoted.
- **The sheet**, with:
  - the latest summary's story, ended, once the work item closes after it, with how it closed: a summary says nothing of where the work item stands. A story triage wrote before it stopped saying so loses the fixed words it ended with; the describer's own words stay as they are;
  - for a ticket, each sense that saw it, and the later versions it saw it in again;
  - a Release and Verify section, one block per release that carried the work item;
  - a scrubber with a chapter per release, and each pass after the first folded to one;
  - a spec waiting for overlapping work (`wait.started`) as a chapter of its own (`WAITS`), ending at a ring that says what it waits for: its card reads "Waiting on overlapping work", at Build, and the line's row says which work item it waits for and why;
  - a look again at a held or waiting work item (`signal.rechecked`) as a chapter: `CLEARED`, `STILL SEEN`, or at the end of a wait `UNSURE`. None moves the work item to Verify or draws a Release and Verify block. While a clearance stands on a hold for Martin, the hold's words on the sheet and the line say the signal cleared, on which version and release, and that closing its pull request closes it as verified.
