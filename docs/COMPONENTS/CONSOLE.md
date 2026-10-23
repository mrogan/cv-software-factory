# Console

The UI for visitors and admin (spec 5). Part of the [factory plane](README.md#factory-plane).

- **v1:** a single-page app written to React's API and run by Preact, built by Vite 8 (ADR 0007) in its own image stage.

## The server

The Node server serves, to anyone, and with `GET` or `HEAD` alone:

- the build, by Vite's manifest;
- the public events, as JSON and as server-sent events resuming from `Last-Event-ID`;
- the artifacts public events refer to.

It writes into the page the profile whose policy bounds Martin's settings and whether the gateway sends every agent to the local model, from the `FACTORY_PROFILE` and `ALL_LOCAL` the gateway reads (`sf-profile` and `sf-all-local`, beside `sf-events`): a visitor needs the bounds as much as Martin does, and they are no secret. With neither set, it is `local`, and not.

Each is a route the access table ([`policy/access.ts`](../../policy/access.ts)) gives the console, which it answers through the table and nothing else: the table is the one list of every route and every action Martin can take, with the role each needs, whether it writes, and whether it needs his passkey again. A test fails when the server answers a route the table does not give it.

Every response carries a strict Content Security Policy (the page's own scripts, styles, fonts and pictures, and connections to its own origin, nothing inline), opener, embedder and resource policies that keep other origins' pages and resources away from it, and a permissions policy that gives away no camera, microphone, location, payment or USB.

## Signing in

Martin's side of the console is the [admin service](ADMIN-SERVICE.md)'s, on the same origin under `/admin/`. The console's server never holds a session or sees the cookie that names one; the page asks the service.

- **Who is looking.** As it opens, the page asks `GET /admin/session`: a session is Martin's, which puts his account button in the header; the service's own refusal is a visitor's, whose footer offers "Martin's sign-in"; anything else (the replay site, `pnpm dev` with no service, a cluster before the service's Deployment) is no service, and offers no sign-in. When the session's eight hours are up, the page sends him to the sign-in page, which says so.
- **The doors.** Signing in (`/?view=sign-in`) and enrolling a passkey (`/?view=enrol`) are pages of their own, as the design system draws them, whose code and passkey ceremonies ([SimpleWebAuthn](https://simplewebauthn.dev)'s browser half) load only there. Each ceremony asks the service for its options, has the browser's own passkey sheet answer, and sends the answer back.
- **The account menu** says when Martin signed in and when the session ends, leads to the settings, and signs out here or everywhere.
- **Writes** are `POST`s of JSON with the session's token in `X-CSRF-Token`, the one the service gave with the session (`write` in `admin.ts`). A write the service refuses for want of the passkey given again opens the step-up dialog, and is sent again once it is given.
- **The passkey, again.** An action the access table marks carries a key after its label while the passkey is not fresh (which actions, and for how long, are copied from `policy/access.ts` into `web/src/access.ts`, since the image is built without it, and a test holds them together). Pressing one opens "Your passkey, again" (`StepUp.tsx`): the action's name, what will happen in a ruled box, why it asks, and **Use your passkey**, which runs the service's step-up ceremony. Once given, the header shows "Passkey given · 5min", counting down, the keys go, and on a phone the count is in the account menu instead. The page's count is a convenience: the service decides.
- **Dialogs** (`Dialog.tsx`) are the browser's own modal `<dialog>`: a raised card on the scrim, a bottom sheet on a phone, its title focused as it opens, and the control that opened it focused again as it closes; Escape, the scrim or Cancel close it.
- **Read only.** Everyone but Martin sees each of his controls as a label (`.ro`) beside what it does, never a greyed-out button.
- **In development,** `pnpm dev` passes `/admin/` to an admin service on the host when `ADMIN_URL` names one, and keeps `Cookie` from the console's server as Traefik does, started with `ADMIN_ORIGIN=http://localhost:5173`: `localhost` is a secure context, so a passkey and the `Secure` cookie work there in Chrome; Safari drops the cookie over plain HTTP.

The browser tests take the doors, and the Canary panel's controls (against a stand-in Rollout), through the real service on a throwaway store, behind a proxy standing in for Traefik, with a virtual passkey; ZAP's baseline scan runs against the same in CI, signed in that way ([CI pipeline](CI-PIPELINE.md#zaps-baseline-scan)).

## The browser

- **It projects.** `project(events, t)` is plain TypeScript, so live and replay are the same code.
- **Replay.** The same build, fed from an event-log folder, is the replay site.

## What the image holds

Neither the factory's code nor the app's repository.

- What the projection shares with the line (its limits, how a scope matches a path, a return's words) is in `@software-factory/events`, which both read.
- The bounds of Martin's settings and the one check of them (`policy/models.ts`, `policy/spend.ts`, `policy/settings.ts`), which the page shares with the gateway, the line and the admin service, so all four agree on what is in force; and the profiles (`policy/spend.ts`) for the server.
- A spend hold carries its cap.
- The app's reviewing rules are the one copy it keeps.

## What it draws

Everything it draws is the design system's (`docs/design/system`):

- **The line**, with each work item at the stage its events place it in. The line writes no event as it starts to verify, so a release's promotion places the work it carries at Verify, where the line puts it then; its row there says so ("Promoted · verifying", or in a dry run, or found live) until a sense has looked.
- **The Canary panel**, full width under the line:
  - draws the newest release from its events, one to a `release` id;
  - shows the steps `release.started` recorded, each step's measures against the baseline, and how it ended: promoted, rolled back, stopped by an analysis error (`release.errored`, with the analysis's words), stopped with the line or aborted by Martin (`release.aborted`; a history from before the line recorded aborts has only `line.stopped` after a release with no end, read as Stop the line's);
  - folds to one line 15 minutes after the release ends, but for a release that was stopped (aborted, or stopped by an analysis error), which stays in full while it is the newest: it waits for Martin's retry;
  - draws Martin's pause (`release.controlled`): "Paused by Martin at 50%", still, holding its weight until he resumes, promotes or aborts it; and a canary he promoted at the step it went to;
  - under the steps and the measures, his controls ([admin service](ADMIN-SERVICE.md#the-canarys-controls)): in flight, Promote to the next step's weight (when there is one before all of the traffic) and Promote fully, each with the key, Pause or Resume, and Abort, behind a dialog that says what it does; stopped, Retry, with the key, disabled while the line is stopped. Promoted, rolled back or a dry run's: none. For Martin they are buttons under "Your controls", for everyone else labels under "Martin's controls"; its last line still says the canary needs nobody to press anything.
- **The scoreboard**, from the latest `score.updated` ([scoreboard](SCOREBOARD.md)).
- **The bottom row**, under the reel, for everyone: Controls, holding for now its Spend group: three meters in ink, the models today against the day's cap, this month against the month's, and the dearest work item today against a work item's cap, `attn` at the cap, and when the day resets, in UTC. Spend is counted from the events (each step's `model.called` and each of triage's `judgement.made`), against the caps in force. A visitor's says it is read only, and who changes it. Needs you joins it, and the line's controls join Spend (tasks 6 and 8).
- **The settings** (`/?view=settings`, `Settings.tsx`, whose code loads only there): "Settings" from Martin's account menu, "Models and spend" from Controls for a visitor.
  - What is in force is the latest `settings.changed` through policy's own check: one outside policy shows policy's default, and says beside the setting that his last one was outside policy.
  - **Models:** a row per agent, with what it does, its model from the profile's models by the sheet's names (a local one marked so), its effort (those above the agent's most listed and disabled, "· above policy", and "up to high" beneath; none for a local model, whose effort LM Studio sets), and its steps and spend in the last seven days. Under `ALL_LOCAL` a line says the gateway sends every agent to the local model whatever is chosen.
  - **Spend caps:** each a field in dollars, a meter of the spend against it, and its ceiling. A month's cap may be left empty where policy has none.
  - **Unsaved changes:** a changed field takes a `signal` rule, and a bar under the caps says each change in words ("the coder’s effort, medium → high"), whether saving asks for the passkey (any raise does: `SETTINGS_STEP_UP`, held to the access table), and has Discard and Save. A cap that is no figure, or is past its ceiling, cannot be saved. Saving sends only what changed ([admin service](ADMIN-SERVICE.md#the-settings)), and the draft stays until the event arrives.
  - **Passkeys** and **This session**, for Martin: each passkey with when it was enrolled and last used, which is this device's, and Revoke, with the key; when he signed in, with which passkey, when the session ends, and signing out here or everywhere. For a visitor, who changes these in their place, beside the spend.
- **The reel**, whose timeline marks each ended release's version, struck through when it was not promoted.
- **The sheet**, with:
  - the latest summary's story, ended, once the work item closes after it, with how it closed: a summary says nothing of where the work item stands. A story triage wrote before it stopped saying so loses the fixed words it ended with; the describer's own words stay as they are;
  - for a ticket, each sense that saw it, and the later versions it saw it in again;
  - a Release and Verify section, one block per release that carried the work item;
  - a scrubber with a chapter per release, and each pass after the first folded to one;
  - a spec waiting for overlapping work (`wait.started`) as a chapter of its own (`WAITS`), ending at a ring that says what it waits for: its card reads "Waiting on overlapping work", at Build, and the line's row says which work item it waits for and why;
  - a look again at a held or waiting work item (`signal.rechecked`) as a chapter: `CLEARED`, `STILL SEEN`, or at the end of a wait `UNSURE`. None moves the work item to Verify or draws a Release and Verify block. While a clearance stands on a hold for Martin, the hold's words on the sheet and the line say the signal cleared, on which version and release, and that closing its pull request closes it as verified.
