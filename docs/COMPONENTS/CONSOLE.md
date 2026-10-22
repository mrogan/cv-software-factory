# Console

The UI for visitors and admin (spec 5). Part of the [factory plane](README.md#factory-plane).

- **v1:** a single-page app written to React's API and run by Preact, built by Vite 8 (ADR 0007) in its own image stage.

## The server

The Node server serves, to anyone, and with `GET` or `HEAD` alone:

- the build, by Vite's manifest;
- the public events, as JSON and as server-sent events resuming from `Last-Event-ID`;
- the artifacts public events refer to.

Each is a route the access table ([`policy/access.ts`](../../policy/access.ts)) gives the console, which it answers through the table and nothing else: the table is the one list of every route and every action Martin can take, with the role each needs, whether it writes, and whether it needs his passkey again. A test fails when the server answers a route the table does not give it.

Every response carries a strict Content Security Policy (the page's own scripts, styles, fonts and pictures, and connections to its own origin, nothing inline), opener, embedder and resource policies that keep other origins' pages and resources away from it, and a permissions policy that gives away no camera, microphone, location, payment or USB.

## Signing in

Martin's side of the console is the [admin service](ADMIN-SERVICE.md)'s, on the same origin under `/admin/`. The console's server never holds a session or sees the cookie that names one; the page asks the service.

- **Who is looking.** As it opens, the page asks `GET /admin/session`: a session is Martin's, which puts his account button in the header; the service's own refusal is a visitor's, whose footer offers "Martin's sign-in"; anything else (the replay site, `pnpm dev` with no service, a cluster before the service's Deployment) is no service, and offers no sign-in. When the session's eight hours are up, the page sends him to the sign-in page, which says so.
- **The doors.** Signing in (`/?view=sign-in`) and enrolling a passkey (`/?view=enrol`) are pages of their own, as the design system draws them, whose code and passkey ceremonies ([SimpleWebAuthn](https://simplewebauthn.dev)'s browser half) load only there. Each ceremony asks the service for its options, has the browser's own passkey sheet answer, and sends the answer back.
- **Which events.** The page draws everything from one projection of whichever events it reads, and the projection cannot tell which. A visitor's page reads the public events from the console's server. Martin's reads the full events from the service's `GET /admin/events/stream`: it opens the public ones at once, as anyone's page does, so a visitor waits on no question to the service, and once the service says the session is his, the full events take over from the public ones as they arrive, each in its public view's place by seq. When the stream ends, or is refused, the page asks the service again: a session that has ended goes back to the public events and to the sign-in page, saying why; one still live, or a service that cannot be asked, opens the stream again.
- **A visitor's report** is quoted on its sheet for Martin alone, under the line everyone reads, marked "Only you see this: a visitor wrote it". Only the full events carry its text, and the page shows it as spec 5.3 says, by `reportText` (`web/src/projection/report.ts`): at most 140 characters of plain ASCII letters, digits and basic punctuation, with links, email addresses and long numbers removed, inserted as text and never as markup.
- **Preview as visitor,** in the header on a desktop and in the account menu, shows Martin the console as anyone without his session gets it: a green banner, "VISITOR VIEW" in his account's place, and everything below drawn from the public events, read afresh from the console's server rather than the full ones with his parts hidden. The full stream closes while it lasts. **Back to admin** reads the full events again; so does a reload, which ends a preview.
- **The account menu** says when Martin signed in and when the session ends, offers Preview as visitor, and signs out here or everywhere.
- **Writes** are `POST`s of JSON with the session's token in `X-CSRF-Token`, the one the service gave with the session.
- **In development,** `pnpm dev` passes `/admin/` to an admin service on the host when `ADMIN_URL` names one, and keeps `Cookie` from the console's server as Traefik does, started with `ADMIN_ORIGIN=http://localhost:5173`: `localhost` is a secure context, so a passkey and the `Secure` cookie work there in Chrome; Safari drops the cookie over plain HTTP.

The browser tests take the doors and Martin's view through the real service and the console's server, both on a throwaway store holding the samples (each visitor's report with a text, as its full event carries one), behind a proxy standing in for Traefik, with a virtual passkey; ZAP's baseline scan runs against the same in CI, signed in that way ([CI pipeline](CI-PIPELINE.md#zaps-baseline-scan)).

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
