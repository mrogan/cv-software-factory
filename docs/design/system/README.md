# Paper & Ink: the Software Factory design system

The console's visual language: colour roles, type, spacing and the station kit. Version 0.1: enough to build the console skeleton and the line; the gaps are listed at the end.

Open [`index.html`](index.html) to see it: every token, both themes, the mark, and every station in every state. The console mockup built from it is [`../mockups/console.html`](../mockups/console.html): plain HTML, CSS and JS, and the reference for `apps/console`.

## Files

| File | What it is | Edit? |
|---|---|---|
| [`tokens.json`](tokens.json) | Source of truth: colour roles per theme, type, space, radius, stroke, shadow, motion, station geometry. W3C Design Tokens (DTCG) format. | Yes |
| [`tokens.css`](tokens.css) | Custom properties and `.t-*` type classes, generated from the JSON. | No: run `build.ts` |
| [`build.ts`](build.ts) | `node docs/design/system/build.ts` (Node 24, no dependencies) regenerates `tokens.css` and `station.js`, and fails if any meaningful colour pair drops below WCAG 2.2 AA. With `--check` it writes nothing and fails if either is out of date; `make check` runs it that way. | Yes |
| [`station.ts`](station.ts) | The `<sf-station>` element: the station kit, which the console imports as it is. No `<style>` element or `style` attribute, so it runs under the console's content security policy. | Yes |
| [`station.js`](station.js) | The same element as a classic script, so design pages open from disk. | No: run `build.ts` |
| [`mark/`](mark/) | The MR monogram: `mark.svg` (Paper), `mark-ink.svg` (Ink), `icon.svg` (favicon and app icon). | Replace, don't edit |
| [`index.html`](index.html) | Specimen page. Opens from disk; `?theme=ink` and `?motion=off` work. | Yes |

The console mockup links `tokens.css` and `station.js` directly, so a change here shows up there on reload.

## Principles

1. **Moving is not news.** Work in flight is neutral ink (`signal`). A busy line looks calm; only a finished, verified result earns green (`ok`).
2. **One warm colour.** `attn` means a person should look: Needs you, a held PR, a failure, a rollback, Stop the line. Nothing else is warm. The one exception is the canary, which is yellow because it is a canary and carries no meaning.
3. **Read it like a log.** Ids, clocks, figures and labels are Geist Mono, tabular. Prose and controls are Geist. Names and headlines are Instrument Serif.
4. **Shape, then colour, then motion.** Every state is distinguishable in greyscale and with motion off. Colour confirms; motion adds life and always stops when asked.

## Colour

Components use role names only, never hex values. Each theme assigns every role, so switching theme is one attribute: `<html data-theme="ink">` (or the class `theme-ink` on any container).

**Paper always comes first.** Every visit opens in Paper, whatever the visitor's system setting. Ink is offered by a switch on the page and is not remembered between visits.

| Role | Use for | Never for |
|---|---|---|
| `bg`, `surface`, `raised` | Page, panels and belt, cards and popovers | |
| `line`, `line-strong` | Hairlines; control borders | Text |
| `text`, `text-2`, `text-muted` | Body; secondary; labels and captions (lowest contrast allowed for meaningful text) | |
| `text-faint` | Disabled, idle, chart baselines | Anything that must be read |
| `signal` (+ `on-signal`, `-hover`, `-wash`, `-line`) | Work in flight, primary buttons, focus rings | Success or alarm |
| `ok` (+ `on-ok`, `-wash`, `-line`, `-text`) | Healthy, passed, verified, canary checks passing | Things merely in progress |
| `attn` (+ `on-attn`, `-wash`, `-line`) | Needs you, held, blocked, failed, rolled back, aborted, Stop the line | Decoration, links, brand |
| `station-face`, `station-led-*` | The station's LED face (always dark) and its glyphs | Anything outside a station |
| `station-canary` | The Release station's bird | Anything else |
| `scrim` | Dimming the page behind the sheet | Anything that carries meaning |

The pattern for "needs you" in cards is a 2px `attn` rule on the left edge (`radius-rule` on that side), not a filled box. The reel's cards are the exception: their outcome dot flashes instead. A stage panel's rows take the same rule: `attn` on a row held or failed, and `ok`, built the same way, on a row verified at Verify.

`build.ts` checks these pairs in both themes: text roles on `bg`, `raised` and `surface` at 4.5:1; `on-*` on their fills at 4.5:1; station linework and LED glyphs at 3:1 (WCAG 1.4.11, graphics). Add a pair when you add a role that carries meaning.

## Type

| Class | Face | Size / line | Use |
|---|---|---|---|
| `t-display` | Instrument Serif | 58 / 1, −1px | App name on the console |
| `t-title` | Instrument Serif | 32 / 1.05 | Panel and work-item titles |
| `t-heading` | Instrument Serif | 26 / 1 | Popover and card headings |
| `t-stage` | Instrument Serif | 23 / 1.1 | Stage names under the stations |
| `t-subtitle` | Instrument Serif italic | 22 | One line of voice under a title |
| `t-body` | Geist | 15 / 1.4 | Prose |
| `t-ui` | Geist | 13 / 1.4 | Buttons, rows, controls |
| `t-caption` | Geist | 12 / 1.45 | Help text, "What am I looking at?" |
| `t-figure` | Geist Mono, tabular | 28 / 1.2 | Scoreboard numbers |
| `t-clock` | Geist Mono, tabular | 24 | The scrubber clock |
| `t-data` | Geist Mono | 11 | Ids, stats, log lines |
| `t-label` | Geist Mono caps, +1.2px | 10.5 | Section labels and kickers |

All three faces are on Google Fonts; self-host them in the app (woff2, `font-display: swap`) so the console has no third-party requests. Sizes are for the 1440 desktop layout; the phone scale is not designed yet.

## Space, shape, motion

- **Space:** 4px base (`--space-1` … `--space-9`); page gutter 48px at desktop.
- **Radius:** 2 (the Needs-you edge), 4 (small controls), 6 (cards, buttons), 8 (panels, popovers), pill.
- **Stroke:** 1px hairlines; 2px for the Needs-you rule, focus rings and the station chassis; 1.75px for station tools.
- **Elevation:** flat. The only shadow is `--shadow-popover`, for panels that float over the line and for the sheet.
- **Motion:** everything stops under `prefers-reduced-motion: reduce` and when the console's motion switch is off, and the still pose must say the same thing. Alarms flash at 0.9s, well under three flashes a second. Flows use `--motion-flow` (1.1s); easing is `--motion-ease`.

## Stations

One station per stage, in the order and names of [`TERMS.md`](../../TERMS.md): Sense, Triage, Plan, Build, Gates, Review, Release, Verify. Each is drawn in a 168 × 220 box, so eight make one continuous 1344px belt: the console's line.

```html
<sf-station kind="gates" status="blocked"></sf-station>             <!-- names itself: "Gates: needs you" -->
<button aria-label="Gates: needs you, 2 PRs. Show what is in this stage">
  <sf-station kind="gates" status="blocked" decorative></sf-station> <!-- the button names it -->
</button>
```

| Attribute | Values |
|---|---|
| `kind` | `sense` `triage` `plan` `build` `gates` `review` `release` `verify` |
| `status` | `idle` `working` `returning` `passing` `blocked` `failed` |
| `beacon` | `needs-you` `failed`: a person should look while the machine works on (below) |
| `motion` | `off` draws the still pose |
| `label` | Overrides the accessible name |
| `decorative` | Hides it from assistive tech when something else names it |

Width scales the drawing (`sf-station { width: 140px }`); height follows.

### What each part says

| Part | Says | idle | working | returning | passing | blocked | failed |
|---|---|---|---|---|---|---|---|
| **Tool** | What the stage does | still | moving | moving | still (gate raised, canary sings) | still | still (canary down) |
| **Face** | How it feels | eyes shut | busy eyes, blinking | glancing back | pleased | squinting | crossed out |
| **Hatch** | Progress | blank | progress bar | left arrow | tick | hazard stripes | FAULT |
| **Beacon** | Whether to look | dim | ink | ink | green glow | flashing ember, rays | flashing ember, rays, sparks, smoke; the machine rattles |
| **Belt** | Flow | still | forward | backwards | forward, slower | still | still |
| **Caption word** | | idle | working | sending back | passed | needs you | failed |
| **Tone role** | | `text-faint` | `signal` | `signal` | `ok` | `attn` | `attn` |

Blocked and failed share `attn` on purpose: both mean a person should act. Their hatch, face, sparks and smoke tell them apart. The rattle comes in a short burst every few seconds and moves the machine, never the belt; with motion off, the sparks and smoke still say it.

### At work, and needing you

The status says what the machine is doing; the beacon says whether a person should look. A station can be at work on one item while another waits for you, so `beacon` lights the alarm on a working or returning station without stopping it: the tool, face, hatch and belt say it is at work, and only the beacon takes `attn`. `beacon="needs-you"` adds the flashing ember and rays; `beacon="failed"` adds the sparks and smoke too, and the rattle. Only a working or returning station shows it: blocked and failed light their own, and an idle or passed station has nothing to look at. The accessible name says both: "Plan: working, needs you".

### From events to a station's status

The console's projection (`apps/console/web/src/projection/line.ts`) works out each station's status from the work items in the stage at time *t*, taking the first rule that matches:

1. **failed:** an item in the stage failed (a gate run, a refusal, a rollback) and nothing has happened since: no retry, no return, no hold for a human; and nothing else in the stage is in progress.
2. **blocked:** an item is waiting on a human (spec approval, held PR, planner question, a visitor's suggestion parked for Martin, a planner's finding parked for him at Triage, a spec that goes beyond its ticket at Review), and nothing else in the stage is in progress; or, at Triage, a spend cap holds, whatever is in progress, since nothing calls a model under a cap.
3. **returning:** an item was sent upstream from this stage in the last 5 minutes.
4. **working:** at least one item is in progress in the stage. A ticket waiting for the planner is in Plan but not in progress: nobody is at work on it.
5. **passing:** an item left the stage for a later one, or was verified in it, in the last 15 minutes, and nothing is in progress.
6. **idle:** otherwise.

Then the beacon: `failed` if an item failed in the stage, as in rule 1, otherwise `needs-you` if an item waits on a human, as in rule 2. Only a working or returning station shows it, since one that failed or is blocked already says so. The caption's word follows the beacon when it is lit, so it always names what a person has to do: "needs you" or "failed".

A failure that a mechanism hands to a human (the test-integrity gate holding a pull request) reads as `blocked`, not `failed`: someone should look, and the hatch says why. Under Stop the line, every station shows `blocked` and the belt stops.

An item whose last step is `ticket.opened` has left Triage and sits at Plan, waiting for the planner, until something happens there; another sense's evidence or a report that repeats the ticket does not take it back up the line. At a spend cap (`spend.capped`, until `spend.cleared`), Triage uses the blocked drawing with its own word, **capped**: it takes no reports until the cap resets, and the senses' tickets still open, because they call no model.

The figure in each caption counts the items in the stage (`2 PRs`), gives a canary's weight at Release (`25%`, a release with no work item's too), says how many are held (a mechanism stopped them) or waiting (the line asked Martin something) when the station is blocked or its beacon says it needs you, counts the tickets queued for an idle stage (`7 waiting`), gives a cap's reset time at a capped Triage (`until 01:00`), and otherwise counts what left the stage today (`3 today`), or says `none`.

### On the line

- Stations sit edge to edge; the rollers at each seam hide the belt joints.
- Parcels (14 × 12, `surface` fill, `text` stroke) ride on the belt top (`--station-belt-top`, 186px), pile up in front of a station that needs you (with one running through it as well, while it works on another), and queue, up to three, in front of an idle station with tickets waiting for it. They are decorative; the counts live in the captions and the stage panel.
- **Returns** are drawn as a dashed `signal` arc over the stations, from the sender back to the receiver, with a one-line label in a small pill (return icon, `t-data`). There are two kinds: a stage sending work back (Review → Build, Gates → Build, Verify → Plan when a signal persists), and Verify feeding new tickets from production back to Sense.
- **A return stays only while it is true.** It is drawn until its work item moves on: its next event that moves it to a stage, a hold, or its close. After that it is a row in the sender's panel, and no longer an arc.
- **One return at a time.** Returns queue newest first and show for about five seconds each, fading in and out. While its arc shows, the sender's station and caption switch to `returning`. With motion off, the newest return holds still. Under Stop the line, none show. Returns are fleeting, so each one is also written as a row in the sender's stage panel.
- **The whole station is the hit target** (a `<button>` wrapping station and caption). Hover lifts the machine 3px through `::part(machine)`; the legs and belt never move, so the line stays continuous. When the stage panel is open, the stage name gets a 2px underline.
- **Entry points sit on the stage they feed.** Admin sees a round `signal` + on Plan (request an improvement), repeated as a button in the Plan panel. Triage's panel lists what it takes work from, after its work: the six senses as rows (the probes, the crawler, metrics and logs watch the stable version; reports are what visitors send; the canary is a release's analysis, which signals when it rolls a release back), each with the signals that became events and the tickets they opened, counted from events alone (so live and replay agree), reports broken down by where triage sent them, and a line saying a sense's repeats within a version are counted by the inbox, not here. A zero is written as `0`, in `text-muted`. Sources that aren't built for the demo (Slack, Linear or Jira) are shown with a dashed border and "not in the demo".
- **A stage panel lists the work first**, the same at every station: the header and blurb, then one list of rows with no group labels, then the station's reference material under a hairline (Triage's sources, Plan's note that tickets wait for the planner). Of the items in the stage now, the list gives what the station is working on, then what is held or failed there, then what waits for it to take it; after them, under a `line-strong` hairline, those that left it today. Each group is newest first, by work-item number. A work item is one row, with its state now; an earlier state it went through today is kept in the row, struck through ("~~sent back~~ · verified"), and read to a screen reader as "earlier". A spend cap that holds is a row with the work, ruled as held; one that cleared today sits with what left today, written as returns are, so anyone who missed it can still see it happened.
- **Each row has a status icon** under its number (or "cap", or a release's version), left-aligned with its first character, 3px below it: 12px, drawn as the console's glyphs are (round caps and joins, 1.5px stroke), the shapes solid and the tick stroked. It is hidden from a screen reader, since the note says the state in words. They are media-player signs, so they read without a key:

  | Row | Icon | Row style |
  |---|---|---|
  | In hand | Play, `signal` at full strength, blinking at `--motion-blink` (still with motion off); `text-faint` and still while the station is stopped, capped or held | Note in `text`; a screen reader hears "working" |
  | Held or failed | Stop, `attn` | The `attn` rule; note in `attn` |
  | Waiting | Pause, `text-faint` | Plain |
  | Passed on today | Next, `text-faint` | Title and note in `text-muted` |
  | Sent back upstream today | Previous, `text-faint` | Title and note in `text-muted` |
  | Verified at Verify | Tick, `ok` | The `ok` rule; note in `ok`, title in `text` |

  A work item still in the stage that was sent back earlier takes its state now's icon; its struck-through earlier state says the rest.
- Under each station: stage name (`t-stage`), a dot and the state word, then the stage's figures and controls. The word is always there, so colour is never the only signal.

### In the app

`station.ts` is a dependency-free custom element, used from the console's JSX as it is (ADR 0007): one constructed stylesheet shared by every station, and a drawing of classes and presentation attributes. The console's policy refuses styles written into markup, but allows those set through the CSSOM: a constructed stylesheet, or an element's `style` property. Each kind in each state, in both themes, has a visual-regression snapshot (96 images), and axe checks the line.

## The reel and the sheet

Work items are shown as a **reel**: one card per work item, oldest on the left and now on the right, scrubbed sideways. Opening a card raises its **sheet** from the bottom of the screen, with everything about that work item.

### The reel

- **One card in the centre**, its neighbours either side at 90% scale and lower opacity, fading out at the reel's edges. Drag the cards, flick them, use the arrow keys, or drag the **timeline** underneath; release snaps to the nearest card. Clicking a neighbour brings it to the centre; clicking the centre card opens its sheet.
- **The timeline** has one mark per work item, in its category glyph and outcome tone, a hairline at the start of each day, the version each release left the app on, once it has ended (a version rolled back, stopped with the line or aborted by Martin is struck through, a release with no work item is marked by its version alone, at its time, and a dry run's release marks nothing), and a playhead. It shows a window of itself around the playhead, the same at every width: each mark has at least 40px, so none overlaps another; when the whole timeline does not fit at that, it slides to keep the playhead in the middle, and an end fades where the timeline goes on past it. Day and version labels that would touch become hairlines. Under it, one line says when the centre card happened and what version the app was then, and, when the work item's own release was rolled back or stopped, says so in words ("v0.9.1 was rolled back"), so a strike-through is never the only sign. The timeline is a slider, and its value says the same: the work item, when, and the app's version.
- **Previous, next and Now** above the reel step it a card at a time and bring it back to the latest work item, beside a count ("72 of 74"). The reel opens at now and moves only when the viewer moves it: nothing plays it. With motion off, the cards move without animating.
- **Needs you** cards (waiting on Martin, or held for a human) flash their outcome dot at `--motion-alarm`, like a station's beacon, and hold it still with its ring when motion is off. They take no edge rule: the picture often carries one already.

### A card

Top to bottom, and nothing else:

1. **Category and kind** on the left (glyph, `t-label` caps, then the kind in `t-caption`); **outcome** on the right: dot and word, in the outcome's tone. Work a visitor started says so ("Injected by a visitor", "Red-team attack by a visitor"), never which visitor.
2. **The picture**, 16:10. See below.
3. **Title** in Instrument Serif 28, and a description clamped to two lines.
4. **One line of facts** in `t-data`: number, version (a pill), pull request, start, duration, model spend. Before a release, the pill says what a sense saw it on ("seen on v0.9.3") or, for a visitor's report, the page it came from at its path only ("from /about"). After a release that did not ship, rolled back or aborted, the pill strikes its version through and points to the one the app stayed on (~~v0.9.11~~ → v0.9.10), with how it ended in visually hidden text for a screen reader; the sheet's Version fact spells it out: "v0.9.10 · rolled back · stayed on v0.9.9", "v0.9.11 · stopped with the line · stayed on v0.9.10" or "v0.9.11 · aborted by Martin · stayed on v0.9.10". Work that called no model says "no model", not "$0.00".
5. **Eight segments**, one per stage: `ok` for passed, a dashed outline for skipped, a solid `text-muted` outline for queued (a ticket waiting for the planner, or a merged fix waiting for a release), `signal` (blinking) for now, `attn` where it stopped or waits on a human, `text-muted` where triage closed it. The segments have an accessible label such as "Stopped at Release".

The outcomes, each a word and a tone. Work nobody needs to act on is in the quiet tone:

| Outcome | Word | Tone and dot |
|---|---|---|
| Verified | Verified | `ok` |
| Rolled back | Rolled back | `attn`, ringed |
| Held for a human, Needs you | Held for a human, Needs you | `attn`, flashing |
| In progress | In progress | `signal`, blinking |
| A ticket waiting for the planner | Waiting for the planner | `text-muted`, hollow |
| A fix Martin merged, waiting for the deploy that carries it | Needs you | `attn`, flashing: while the factory is Supervised, the deploy pull request is Martin's to merge. The same after the release that carried it rolled back or was aborted |
| A ticket open again after it was verified | Its outcome now, with an outline REOPENED pill before it | The outcome's own |
| Closed with no change | Closed · no change | `text-muted` |
| A report that described nothing wrong | Closed · no ticket | `text-muted` |
| A report that gave orders to the system | Quarantined | `text-muted`: a guardrail worked, and nobody needs to act |
| A visitor's suggestion, parked for Martin | Needs you | `attn`, flashing; Triage says "needs you" too |

### The picture

The picture is evidence, so it is always something the factory captured, never an illustration.

| Work | Picture |
|---|---|
| A visible change | Screenshots before and after, with a **wipe** between them: a 2px `signal` divider and a round handle (drag it, or arrow keys on it). Each side is its own stacking context, so nothing drawn on one side shows through the other. Tags in the bottom corners name each side (BEFORE, BROKEN, FIXED, NOW) with its version. |
| Performance | The metric over time, one series, with the objective dashed and the release marked; the headline before → after above it; a strip of page thumbnails saying no page changed |
| Dependency update | Package logo and the version change; the screenshot strip below |
| Security | Package logo and version change, and the image scan's findings before and after by severity |
| Rollback | Canary against baseline on one axis, the rollback marked; a line saying how much traffic never saw it. With no series (rolled back before a step was measured), the routes where it did worse, as the canary's ticket shows them |
| A canary's ticket | "Rolled back at 25% · 3min in", the routes where the canary did worse as paired bars (canary `attn`, baseline faint) with both figures, or the journeys' checks that failed on it; the analysis's words on the station face; how much traffic never saw it |
| Merged, waiting for Martin's deploy | "Merged · waiting for Martin's deploy" in the `attn`-ruled panel: the pull request and its title in mono, a tick for the merge, hollow rings for the deploy pull request and the canary to come, and that the deploy is Martin's while the factory is Supervised. When the release that carried it rolled back, "Rolled back · waiting for Martin's next deploy", with a cross for that release, its version and when; when it was aborted, "Stopped with the line · waiting for Martin's retry or next deploy" or "Aborted by Martin · waiting for his retry or next deploy" |
| A sense's ticket, after a release | A probe's or crawler's: its own page on a wipe, SEEN against CANARY while the canary runs, SEEN against FIXED once verified (BEFORE against FIXED when the signal had no shot). The logs' or metrics': their own picture at signal and at verification, no wipe |
| Red-team attack | The gate's or policy's own refusal, verbatim, on the station face colour; "the site never changed" |
| Not a defect, or a report's ticket | The page the report was about, and Jev's typed answers with their probabilities: what kind of report, how badly it hurts, and whether it gives orders to a system |
| Observability | Log lines before and after, and the trace they now link to |
| Waiting on Martin for a spec | Held at Plan for his approval, or for his answer to the planner's question: the spec, outcome, acceptance criteria and the planner's question, with the `attn` rule, captioned "Spec · waiting for Martin" |
| A spec, with nothing better to show | The spec, captioned "Spec", ruled in `line-strong`, with no question: it says what the work set out to do, and waits for nobody, whatever else the work item waits for and once it has closed |
| Waiting for Martin's merge | The pull request, in the same `attn`-ruled panel: "PR #1312 · waiting for Martin's merge", its title in mono, and three ticks that answer "is it safe to merge?" (every required check passed, its tests fail without the fix, the reviewer approved), with the size of the whole change at the foot: every round together, as the merge brings it in. A dependency update keeps its package picture |
| Held by the scope fence | "Held at Build · patch outside its scope, twice", and the fence's own output on the terminal face ("scope fence · patch 2 refused"), each refused path in `attn`, with a line for the patch sent back before it |
| Held by the tests-first check | "Held at Gates · its tests pass without the fix", the check's own output, and a line saying a test that passes before the fix proves nothing about it |
| Held at the spend cap | "Held at Build · its spend cap reached", what the work item spent as a big figure, a bar of it by agent in ink (the money is not the fault), and the cap |
| Held, still blocking after two reviews | "Held at Review · still blocking after two reviews", each open finding with its line and its rule, and the reviews it blocked; Martin decides: merge, close or send back |
| A sense's ticket, waiting | What the sense captured: its screenshot with the mark, tagged SEEN and the version; where there is nothing on the page to point at, what it recorded instead (below) |
| A problem on every page (`*`) | Four of the pages, each with its mark and its route, and a tag: EVERY PAGE · +N MORE. The sheet has them all |
| An HTTP exchange | Structured, on the card's surface: the request, the status (or "No response", dashed), each redirect (a loop drawn once, with an arrow back to the start), each header the check read with a tick or a cross and its value ("absent" in `attn`), and the timings |
| The browser's console | Its messages word for word on the terminal face (✕ error, ! warning, the source dimmed), beside the page's screenshot, unmarked: a console error has no place on the page |
| An accessibility check | The screenshot with each element axe named numbered, and the list beside it: the rule, its impact, its help, and each element by number; one out of view has a dashed number and "out of view" |
| A quarantined report | Jev's answer that decided it, first and large, on an ink bar against the threshold that quarantines ("quarantined at 0.50"), a QUARANTINED stamp, the other answers below as unused, and a dashed line saying the text is shown to nobody but Martin and its sender. No page: it has nothing to do with an attack |
| A visitor's suggestion | The waiting-on-Martin pattern: "Suggestion · waiting for Martin" with the `attn` rule, the page the report named, Jev's answers with the category first, and that only Martin asks for improvements |

**Marks** on a screenshot are drawn by the factory from the elements its probe checked: a dashed `attn` outline for the problem and a solid `ok` outline for the fix, or for the page as it should be, each with a short label in a filled tag. Both sides of a wipe carry a mark, and never more than one label per side. Several marks on one screenshot are **numbered** instead, keyed to a list beside it: the list does the labelling, and has room for what is out of view. A number keeps a minimum size, so it reads on a thumbnail.

On a small picture (a phone's card, a block in the sheet's evidence), each picture keeps its headline and drops its secondary rows: timings, the hops after the first two, a rule's full sentence, the unused answers. Type inside the new pictures never drops below 9px.

Package logos come from [theSVG](https://github.com/glincker/thesvg) (MIT; the marks belong to their owners) and are bundled with the console, never fetched.

### The sheet

- Rises from the bottom to 90% of the viewport height (94% on a phone) over a `scrim`, with `--shadow-popover` and 14px top corners. Escape, the close button or the scrim close it, and focus returns to where it was. Previous and next step between work items, and the reel follows behind.
- **Main column:** a paragraph saying what happened, and who wrote it once the describer has. A summary says nothing of where the work item stands, so once it closes the console ends the paragraph with a sentence of its own, from the events: verified on which version by which check ("It was verified on v0.9.8 by the probe's check “the contact form sends”, and closed."), closed with the reason Martin or the line gave, or closed with its pull request unmerged; a summary written at the close says so itself, and gets none; for a visitor's report, the report (below); **How it went**, the stage scrubber with the site's screenshot at each step; **Evidence**, the problem's own evidence at full size (while the card shows what Martin is asked to decide, the sheet still shows what was wrong) and the screenshots captured at signal, canary and rollout; **Release and Verify**, each release that carried it and every page compared with the version before (see Shipping); **The spec** (or **The change**, where there is no spec), **Rounds** and **Review** (below).
- **Side column:** the facts (including "Code written by humans: 0 lines"), **Agents and models** (each agent's model, settings, steps, calls, tokens and cost, with a total), and **Gates** (each check, its result and time).
- Each evidence block ends with a one-line **Source**: where the factory got it.

**A ticket's sheet** says who saw the problem and who was asked:

- The facts gain the ticket's category and severity, its fingerprint ("/contact · server-error"), and "Seen on" the version a sense saw it on. Model spend says "none" when no model was called.
- **Seen by**, after the facts: every sense in order of when it first saw the problem, its check and the time, "opened the ticket" under the one that did and what each other one added; every other sense says "None yet", except the canary, which is listed only when it saw the problem, since it sees only a release doing worse than the version before it and no ticket waits on it. It replaces the single "Found by" fact. A line says each sense adds its evidence once per version, and the inbox counts the rest.
- **Evidence**, when more than one sense saw it: one block for each, the picture its own capture makes, captioned with the sense and when.
- **Agents and models** names the provider on every row, read from the event: "Jev 1.13.0 · TypeSafe" for `judgement.made`, with each question set asked ("triage/v2 · 4 questions"); "Claude Opus 5.5 · Anthropic", or "· Amazon Bedrock", from `model.called`. Jev's tokens aren't in the event, so that column shows a dash. When no model was called, a sentence says why: a sense knows what it saw, so the policy's table gives the category and severity.
- The scrubber ends on a larger hollow ring, labelled "WAITING · PLAN", while the ticket waits; later senses' chapters are named by their sense. A quarantine's chapter is in the quiet tone.
- A quarantined report's withheld block says it gave orders to the system, and that its text is kept, shown only to Martin and its sender.

### A visitor's report

Report text is untrusted. The console shows it only to Martin and to the visitor whose key sent it, sanitised to at most 140 characters of plain ASCII letters, digits and basic punctuation, with links, email addresses and long numbers removed, and inserted as a text node, never as markup. Everyone else sees that a report was made, and what triage made of it.

### When there is nothing ordinary to show

The console never shows a spinner or a blank panel. Whatever it can't show, it says so in a sentence, where the missing thing would be, and keeps everything else.

| State | What the console shows |
|---|---|
| Reading the first events | The header says "Connecting to the factory" by a `faint` dot. The line is drawn with every station idle and each caption reading "reading", and the stations can't be opened yet. |
| Can't reach the factory | The header says "Can't reach the factory". A notice under the header says the console tries again every few seconds; the line appears when the factory answers. |
| The stream dropped | The header says "Reconnecting" by a blinking `signal` dot, and a notice gives the time it dropped. Everything already shown stays, and the console catches up on what it missed when it is back. |
| No work yet | Where the reel would be: "Nothing yet", what a card will show, and `make samples` for someone running it themselves. |
| No work yet, in a store for real events | "Watching, nothing yet": the senses check the app every few minutes and on every new version, a passing check writes nothing, and the first tickets usually appear within fifteen minutes; `make samples` won't load into a real store, and `make status` shows the senses running. The server's stream says what the store holds as its first message (from the store's own record, not an event), and the console waits for it before saying either. |
| A spend cap reached | The header says "Line running · spend cap reached" by an `attn` ring, Triage says "capped" and until when, and a notice gives the spend against the cap, when it resets (in UTC and where the viewer is), and that reports wait in the inbox, none lost, while the senses' tickets still open. When it clears, all three go, and a row stays in Triage's panel for the day. |
| Samples | A notice over the reel says the work items were written by hand, that the screenshots are of the real app with each change made in a copy that went nowhere, and that the factory's own work replaces them. Every sample's card and sheet carry a dashed "Sample" pill too. |
| Events from a newer factory | A notice says how many were left out, and that reloading fetches the newer console. |
| A screenshot that won't load | The picture's frame stays, with "Screenshot unavailable" and a line saying the rest of the work item is still there. |

A notice is a `t-label` word and a sentence in `text-2`, inside a dashed `line-strong` outline: the same dashed edge as the Sample pill, so the console's remarks about itself never look like the factory's work. Notices about the connection are announced politely to screen readers. Toasts are not used: nothing the console says needs to interrupt.

## Mark

An **MR monogram**: Martin Rogan's initials in Instrument Serif, with the R set so that it shares the M's last stem, and a full stop in `attn`. The shared stem makes two letters read as one mark. The ember full stop is the same colour that means "a person should look" on the console, so it carries the system's idea into the signature.

- **On the page:** inline the SVG with `fill: currentColor` for the letters and `var(--attn)` for the full stop, so it follows the theme. Height 30px in the header and 18px in the footer, with a hairline rule between the mark and "Software Factory".
- **Files:** `mark/mark.svg` (Paper), `mark/mark-ink.svg` (Ink) and `mark/icon.svg`: the monogram in paper on the station-face dark square, for favicons and app icons. It reads down to 16px.
- **Beyond the console:** the same mark and ember full stop can sign the CV, the README and the social card, with "Martin Rogan." set in Instrument Serif.
- Letterforms are from Instrument Serif (SIL Open Font Licence), which allows its use in a logo.

## Layout

One page, three widths. The console is designed to be read from top to bottom: *is it running → what is happening → what does it need from me*.

The Canary panel sits full width directly under the line, at every width: it is the Release station opened up. The bottom row, Needs you (or Try it yourself) and Controls, comes with milestone 8, under the reel.

| Width | The line | The Canary panel | The reel and the sheet | Bottom row |
|---|---|---|---|---|
| ≥ 1180 | 8 stations in a row, scaled to fit; captions show state and one figure | The steps on the left, the measures on the right | Cards up to 620px with both neighbours showing; the sheet in two columns | Needs you (or Try it yourself), Controls |
| 721–1179 | Same row, smaller; captions show state only | The same, narrower | The same reel; the sheet in one column, its side column as two cards side by side | The same |
| ≤ 720 | **Two rows of four stations**, reading left to right like text; the current return becomes one line of text underneath; tapping a station opens a bottom sheet | One column: the steps, then the measures, each baseline under its canary figure | Cards the width of the screen with neighbours just showing; the timeline the same window as at every width, a few work items either side of the playhead; the sheet at 94% height, one column, its scrubber showing dots and the current label | One column |

The phone keeps the stations: they are the thing people remember, and at a quarter of the width the face, hatch and beacon still read. What goes on the phone is detail: figures, the parcels on the belt, and the return arcs.

## What the console shows, and what it leaves out

Each panel does one job:

- **Header:** mark, name, whether the line is running (with the autonomy level), and Stop the line. Autonomy is set in Controls.
- **Scoreboard:** three figures: found, verified fixed, median time to verified. No totals, false positives or separate "fixed" count: "fixed" and "verified" are too close to earn two places.
- **Canary:** the release in flight against the version it replaces, step by step, for everyone. It says the canary decides for itself; promote, hold and roll back are admin's, in milestone 8.
- **Captions under stations:** the name and one line: state word and one figure. Descriptions belong in the stage panel, switches in Controls.
- **The reel:** every work item, oldest to now. Watching the app change says more than a list; what waits on Martin is also listed in Needs you.
- **The sheet:** one work item in full: the stage scrubber and the site at each step, the evidence, the change, the model calls and the gates.
- **Needs you:** one card per work item (a spec and the planner's question on it are one decision). Requesting an improvement lives on the Plan station, not here.
- **Controls:** autonomy, three switches and two spend meters. Guardrails that can't be switched off are not drawn as switches; one line says so.
- **Left out on purpose:** placeholders for other apps, a live-feed ticker (the stations and the reel already show what is happening), an always-on feedback loop under the belt (production feeding Sense is a return like any other), sparklines, and help text that repeats itself.

## Sensing and triage (milestone 4)

The states the factory's first real work brings, agreed as a set: a sense's ticket waiting at Plan, the pictures for what a screenshot can't show, reports quarantined, parked or closed, a ticket's sheet, where Triage's work comes from, the spend cap, and an empty store for real events. Each is described above where it belongs. The console's tests draw every one from invented test data (`apps/console/test/fixture`), which the console never ships: in Paper at all three widths, the spend cap and a ticket's sheet in Ink too, and with axe in both themes on a laptop and a phone.

## Fixing (milestone 5)

The states real fixes bring, agreed as a set: a fix's spec and scope, its rounds, its review thread, its gates by attempt, a round on the line, the wait for Martin's merge, the four ways a fix is held, a merge waiting for a release, a local model at no cost, and the describer's step. Each is drawn from the samples' last seven work items: in Paper at all three widths, the sheet's new parts in Ink too, and with axe in both themes on a laptop and a phone.

- **The spec:** the outcome in Instrument Serif, the criteria, then the scope as a table of the paths it allows, each with the lines the pull request adds and removes there, every round together, or "untouched", and any path changed outside the scope. When the fence refused the coder's last patch, the table shows that patch ("May change · patch 2, refused") and each path outside the scope is struck through in `attn`, and named as refused to a screen reader. Risks and rollout under it. The scope is the fence the line enforces, so a reader sees the fence a refusal is about.
- **Rounds:** a grid, one row per attempt (the coder's round of the same number, as the line counts it) and one column each for Build, Gates and Review, with the line's dashed return arc between two rows and the reason in its pill ("Review → Build · 2 blocking", or "Review → Build · 2 suggestions" for an approval's suggestions, "2 suggestions, declined" when the coder declined them all and pushed nothing, so no row follows). Under the last row, what the work waits for now. A round is ordinary work, in ink; "Changes asked" is never `attn`. On a phone the grid keeps its three columns, narrower. The facts count reviews, not rounds, against the most there may be ("Reviews 1 of 2"): a return from the gates is a round, and no review. A round sent back from Review after the last review the line allows, for an approval's suggestions or by Martin, is reviewed too, so the most grows by one ("Reviews 3 of 3"). The line bounds each pass's reviews alone, so the facts count those of the pass the pull request beside them belongs to, and name that pass once there is more than one ("Reviews 1 of 2 · pass 2").
- **Review:** each review as the reviewer posted it ("Review 1 · attempt 2"), its verdict and note, then each finding: where it is (`path:line`), whether it blocks, what it says, and the rule it cites by number and in full, as the app's `docs/REVIEWERS.md` words it, or the spec's criterion it cites. Blocking is solid ink and a suggestion dashed, so shape tells them apart in greyscale; a finding still blocking when the work is held turns `attn`, because then a person must act.
- **Gates** says which attempt it shows, lists the required checks, then, under "Signals, not required", the tests-first check and the reviewer's check run, each with its own one line. A line for each earlier attempt says how it went.
- **Agents and models:** a model run on the local model has a laptop glyph instead of a company's logo, a readable name ("Qwen3.8 27B · local"), and costs "$0" in `text-muted`, never "$0.00". When every call was local, the total says "all local" and the card's fact "$0 · local". Each row counts its agent's steps; the describer is last.
- **The describer:** the story's source line says the describer wrote it, from what; the scrubber has a DESCRIBED chapter; the facts link the pull request on GitHub, where its description lives. A sample's pull request links nowhere.
- **On the line:** a return's pill names the work item, the round and why ("#1311 · round 2 · 2 blocking"), from what the return records, in the words the line writes in its summary; on a phone the line under the stations names the stages too. Review's panel lists the wait for Martin's merge as "Needs you · waiting for Martin's merge", and a return as "Sent back to Build".
- **Holds:** each picture follows the cause the hold records (`merge`, `scope`, `tests-first`, `spend`, `review`). A hold with another cause, or whose events lack what its picture shows, keeps the problem's evidence on the card, and its reason says why it waits.
- **A merge:** the scrubber gets a MERGED chapter; for a fix waiting for Martin's deploy it is the last but one, before the waiting ring, and Release counts it as "1 waiting", with a parcel on the belt.

## Shipping (milestone 6)

The states that shipping brings, agreed as a set: the Canary panel, the scoreboard, the wait for Martin's deploy, each release's steps on the sheet, a rollback and its ticket, Verify and the pages it compared, a return from Verify, a reopened ticket, a dry run, and the scrubber for work that goes round more than once. The mockup draws each of them (`?canary=` and `?score=` show the panel's and the scoreboard's states; its comment lists them), and the console's tests draw them from the samples: in Paper at all three widths, the panel and the sheet's new section in Ink too, and with axe in both themes on a laptop and a phone.

### The Canary panel

The release in flight against the version it would replace, for everyone, full width under the line. It is always there: idle, it is one line.

- **What it is drawn from:** every release event, on a work item or on the line, one release to a `release` id (a release that carries two work items has its events on each, and is drawn once). The panel shows the newest release while it is in flight and for 15 minutes after it ends, the same window as a station's "passed"; then it folds to one line.
- **Head:** the state as a kicker (a dot and `t-label` caps, in the state's tone); the title in Instrument Serif: the carried work item's title, the first and "and 2 more", or "Carries no work item"; under it "Carries #1302", each number opening its sheet. On the right, in `t-data`: the release's id, the version before and the new one with its commit, and the image's digest with "signed · admitted", from `release.started`.
- **The steps:** a bar that is the canary's share of the traffic, from 0 to 100%, with a stop at each step's weight. The steps are `release.started`'s (version 3): one per weight the Rollout sets, each with its pause; the final 100% is not listed, so the panel adds it, as "all". Under each stop, the weight and the pause ("3min", or "waits" for a pause that waits for someone), and "not judged" for a step the analysis does not measure. A step measured passing is an `ok` ring with a tick, a failed one `attn` with a cross, the step being measured a `signal` ring with a dot, and a step to come an empty ring. The bar fills to the canary's weight in the release's tone; a rollback's step is an `attn` cross, and an abort's (Stop the line's or Martin's) a dashed `attn` ring, named "stopped here" or "aborted here". When a release has no steps recorded (a version 2 event, a release found already live), the steps measured stand in, then 100%.
- **The measures,** at the latest step measured: a table captioned "At the 25% step · measured 16:44:00", one row each for requests, errors, latency and the journeys, with the canary's figure, the baseline's in `text-muted`, and the verdict. Each measure has its rule in one caption line, in `policy/release.ts`'s terms ("share of 5xx answers · fails more than a point above"). Figures are tabular mono: requests counted, the 5xx share to two decimals, p99 in ms, and the journeys as "24 / 24" only when the step recorded counts; otherwise "—", and the verdict alone. The verdicts, from the analysis's own phases: **passed** (`ok`, tick), **failed** (`attn`, cross, and a 2px `attn` rule down the row's left edge), **measuring** (`signal`, ring), **waiting** (`text-muted`), **could not measure** for an error, which the analysis tries again (`text-muted`, with its message as the caption), and **inconclusive · waits for Martin** (`attn`, ring), since Argo Rollouts pauses the release until someone decides. Before the first step is measured the table waits: the same four rows with their rules, "—" for each figure and **measuring** for each verdict, captioned with the step in flight and when it is measured ("At the 25% step · measuring until 16:41:00"), so the panel never looks as if something failed to load. It waits only for a step the analysis judges when its pause runs out: a step that is not judged, or that waits for someone, has no table, and the note says why; nor has a dry run, which measures nothing. A rollback before the first step is measured replaces it with the rollback's own table.
- **The note,** under the steps, says what happens next in the release's own times: "Measuring the 50% step until 16:47:30. If every measure passes, the canary takes all the traffic then; if one fails, it rolls back on its own."
- **Last line, for everyone:** "The canary moves on by itself while every measure passes, and rolls back by itself the moment one fails. Nobody needs to press anything." Promote, hold and roll back are admin's, in milestone 8, and arrive with the bottom row.

| State | Kicker | Tone | The note says |
|---|---|---|---|
| In flight | Canary · 50% of traffic | `signal`, blinking dot | when the step is measured, and what happens then |
| Promoted | Promoted · all traffic | `ok` | when, how long it took, and that Verify now asks each ticket's sense |
| Rolled back | Rolled back at 25% | `attn`, ringed | when, and how much of the traffic never saw it: "75% of the traffic never saw it: it stayed on v0.9.9" |
| Stopped by an analysis error | Stopped by an analysis error at 25% | `attn`, ringed | that the analysis could not judge the canary, so nothing failed and it is no signal, that the version before takes all the traffic, and that the release stays stopped until Martin retries it or a new deploy starts another |
| Stopped with the line | Stopped with the line at 50% | `attn`, ringed | that the version before takes all the traffic, and the release stays stopped until Martin retries it or a new deploy starts another; starting the line does not resume it |
| Aborted by Martin | Aborted by Martin at 25% | `attn`, ringed | that the version before takes all the traffic, and the release stays aborted until he retries it or a new deploy starts another |
| A dry run | "Canary · 50%, as the dry run records it", then a dashed "Dry run" pill | `text-muted` throughout | that the dry run answers for it: its merges were never made, so nothing shipped and nothing was measured |
| Idle | "No release in flight", then "The last, v0.9.13, was promoted at 16:47 carrying #1302 · release 3b7e90c1d4-913" | `text-faint` dot; the last release's word in its own tone | (one line) |
| No release yet | "No release yet. Each deploy Martin merges goes out here as a canary, beside the version it would replace." | | (one line) |

Yellow stays the Release station's bird. Moving is ink, a measure that passed and a promotion are green, a failure, a rollback, an analysis error and an abort are warm (principles 1 and 2).

- **A rollback:** the measures with the failed row ruled, then the analysis's words, verbatim, on the station face, as a refusal is shown. With no step measured, a sentence says so ("No step was measured: it rolled back 3min into the 25% step, so the failed measure is the whole story") over a table of the measures `release.rolled-back` failed, each with what the analysis saw against its limit. Each failed verdict says how many of the measure's looks failed in the run that failed it, as the rollback counted them (version 3): "failed twice", never "twice in a row", since Argo Rollouts counts them across a run. A rollback that did not count them says "failed", and so does the measures table's row for a measure two runs failed (a step's and the background's), since neither count is the step's; the rollback's own table says each run's. When the rollback's signal reached a ticket, a line links it and says what the signal did: "A rollback is a signal: triage opened #1308 Slow responses in a canary release", or "reopened", or "added it to" a ticket already open.
- **An analysis error** is `release.errored`: the step it could not judge, its measures saying "could not measure" with the analysis's words beside each, or, when the background analysis erred between steps, a table of the measures it could not take; then the analysis's words, verbatim, as a rollback's are. Its step is a dashed `attn` ring, named "could not be judged here", and it opens no ticket. The scrubber's chapter is ERROR ("v0.9.11 stopped by an analysis error at 25%"), and the fix waits as after an abort: "Stopped by an analysis error · waiting for Martin's retry or next deploy".
- **An abort** is `release.aborted`, and its `by` says whose: `stop` is Stop the line's, drawn as stopped with the line; `martin` is his own, drawn as aborted by Martin. The event carries no weight, so the step is the one the canary had reached at `abortedAt`, worked out from the release's steps. A history with no `release.aborted` in it yet (a recording, the store's past) has only the stop, so there a `line.stopped` while the newest release has no end reads as Stop the line's abort; once the history records an abort, no stop is read as one.
- **A dry run** earns no green and no warmth: its stops and verdicts are `text-muted` ("recorded"), its figures "—", and its image line "no image: nothing shipped". The dashed pill is the console's remark, like Sample.
- **A release with no work item** (Martin's own commits, a dependency update) is drawn the same, titled "Carries no work item", with one line saying it is on the line, not the reel, unless it rolls back; its rollback's ticket is how it reaches the reel. The Release station counts it in its figure, Release's panel lists it as a row named by its version ("v0.9.10 · A release with no work item · rolled back at 25% · opened #1308", "reopened" or "added it to"; or "stopped by an analysis error at 25%", "stopped with the line at 50%", "aborted by Martin at 25%"), which opens nothing, and the timeline marks its version.
- **Widths:** from 721 up, the release's ids sit on the right of the head, the steps and note on the left of the body and the measures on the right. On a phone it is one column; the ids go under the title, each baseline figure goes under its canary figure, and the rules' caption lines are dropped.

### The scoreboard

- Three figures beside the app's name, from the latest `score.updated`: **found**, **verified fixed** (in `ok`, once it is above zero) and **median to verified**, as the console writes a duration ("1h 52min": no space between a figure and its unit, so that in mono it reads as one value, and a no-break space between the parts). `t-figure` mono, captions in `t-caption` `text-muted`; the group is named "Scoreboard: seeded and injected defects".
- Before the first verified fix, the median is "—" in `text-muted`, named "none yet", and verified fixed is a plain 0.
- **Off:** a `score.updated` that says the scoreboard has no answer key draws "Scoreboard off" in mono `text-muted`, and one line: "This copy of the factory has no answer key, so it counts nothing." No `score.updated` at all (an older store, the replay site) draws nothing.
- **Samples:** the dashed Sample pill, above the figures.
- **Phone:** under the name and the line's status, left-aligned, 26px.
- The figures never name a ticket, and found moves only on the scoreboard's slow cadence; the console shows them as they are and says nothing of either.

### Release and Verify on the line and the cards

- **The wait for Martin's deploy:** a merged work item holds at Release for the deploy pull request that will carry it. It is an approval, so its card says Needs you, flashing, and its Release segment is `attn`. The picture and the sheet's block (below) are the waiting-on-Martin pattern: "Merged · waiting for Martin's deploy", the pull request and its title in mono, a tick for the merge (by Martin, when, its commit) and hollow rings for what comes after ("The next deploy pull request carries it, with its ticket and issue"; "Then a canary against the version before, and Verify"), and "While the factory is Supervised, merging the deploy is Martin's. Everything after it is unattended." When the release that carried it rolled back, the caption reads "Rolled back · waiting for Martin's next deploy", and a cross after the merge's tick says when, with the version. When it was aborted, the caption reads "Stopped with the line · waiting for Martin's retry or next deploy" or "Aborted by Martin · waiting for his retry or next deploy", the cross says "The release that carried it was aborted by Martin at 16:20" (or "was stopped with the line"), and the first hollow ring reads "Martin's retry carries it on, or the next deploy pull request, with its ticket and issue". The events name no deploy pull request, so none is drawn. While the station works on a canary its beacon says it needs you too ("needs you · 50% · 1 waiting"); its panel's row reads "Needs you · waiting for Martin's deploy", or, when the release that carried the fix rolled back, "Needs you · rolled back, waiting for Martin's next deploy", and when it was aborted, "Needs you · stopped with the line, waiting for Martin's retry or next deploy" or "Needs you · aborted by Martin, waiting for his retry or next deploy". A `release.started` that carries the work item ends the wait.
- **Verify holds for Martin** when only a visitor's report saw the problem, or when the sense could not tell for a day: Held for a human, the same pattern, "Held at Verify · Martin judges whether it cleared", with the report's page before and after on a wipe, or the sense's last reason in its words.
- **A persisting signal** sends the work back by itself, like a round, so it is never warm the first time: Verify → Plan is a return like any other ("#1310 · persists · back to Plan"). A second time, the work item holds for Martin, and that is `attn`.
- **A reopened ticket:** while it is open again (from `work-item.reopened` until it next closes), its card and its sheet's kicker carry an outlined REOPENED pill before the outcome, whose word and tone are its own (In progress, Waiting for the planner). Its version pill says "back on v0.9.11". The sheet's facts gain "Reopened · Sat 15:58 · logs, a new error pattern on / from v0.9.11": the sense, what it saw, and on which version, from the event.
- **A canary's ticket** comes from a rollback, so its card's picture is the rollback's: "Rolled back at 25% · 3min in", a headline ("v0.9.10 was slower than v0.9.9"), the routes where the canary did worse, worst first, up to four on a card, as paired bars with both figures; or, for the journeys, each check that passed on the baseline and failed on the canary. Then the analysis's words on the station face, and how much of the traffic never saw it. With a series, the series' chart takes the routes' place on the card, and the routes go to the sheet; without one, a line says there is no series to draw. Its version pill says "seen on" the version that rolled back.
- **The wipe at signal, canary and rollout:** for a probe's or crawler's ticket, the sides come from the pictures taken for it: its own page when the sense saw it (SEEN, `attn` dot), on the canary (CANARY, `signal` dot) and after full rollout (FIXED, `ok` dot), each tag with its version. The card wipes SEEN against CANARY while the canary runs, and SEEN against FIXED once verified; with no shot at the signal, BEFORE (the version before) against FIXED. A ticket from the logs or the metrics keeps its own picture, at signal and at verification: a page shows nothing of a log line.

### Release and Verify on the sheet

- **Evidence** keeps the problem's evidence and the three captures in a strip, each tagged as on the wipe. Tags inside a small picture never drop below 9px.
- **Release and Verify** is a section of its own, after Evidence. One block for each release that carried the work item, newest first; the older ones are folded to their head, with "Show this release". A block:
  - its head: "Release 6c9894bdfd-909 · Sat 12:40" and the state word, as on the panel;
  - one `t-data` line: the version before and the new one, the commit, the digest, signed, admitted, and "with #1301" when it carried other work items;
  - a table, one row per measured step: the step, when it was measured, requests, errors and p99, each the canary's figure over the baseline's in `text-muted`, errors and latency with their verdict's glyph, and the journeys as counts or the verdict; "No step was measured" when there were none. On a phone the measured time and requests go;
  - how it ended: "Promoted at 12:47:28, 7min after it started", or "Rolled back at 25% at 14:29:56", the share of traffic that never saw it, and the analysis's words on the station face; or "Stopped with the line at 50% at 16:45:12" or "Aborted by Martin at 25% at 16:20:04", that the version before takes all the traffic, and that the release stays stopped (or aborted) until Martin retries it or a new deploy starts another;
  - its verification, under a dashed rule.
- **The verify block:** "Verify · the log watcher · server-error on /" and the outcome: **Cleared** (`ok`, tick), **Persists · back to Plan** (`signal`, cross) or **Persists again · held for Martin** (`attn`, cross); the sense's own words on the station face; when, and on which version; then **every page against the version before**: up to four pages, the intended one first, then any that changed, then the same, each with its share of pixels changed and the word (intended, changed, same, in `text`, `text` and `ok`), and "And 8 more pages, the same to the pixel". Only the ticket's own check is marked, and only on its own page; a sense that looks at no page (the logs, the metrics, the canary) marks nothing, and a line says so.
- **A tall screenshot** is the whole page, 1280 wide and up to 1600 tall. Its frame stays 16:10 and shows the window of the shot that holds its first mark, with the mark about a third of the way down, kept within the shot; a shot with no mark shows its top. Marks are placed in the image's own scale, measured by its width, never as a share of its height. A mark outside the window is not drawn out of place: a dashed `attn` strip at the frame's foot counts it ("↓ 1 more mark outside the frame", with ↑ or ↕ as fits). The two sides of a wipe share one window, taken from the after side's first mark, or else the before side's, so they line up. A shot shorter than the frame is shown whole, from the top, never cropped at the sides.
- **The wait for Martin's deploy** is the section's one block while it waits, with the `attn` rule.
- **The scrubber** has one chapter for each release, named by how it ended (PROMOTED, ROLLED BACK, STOPPED for Stop the line's abort, ABORTED for Martin's, or CANARY while in flight; the text reads "v0.9.11 aborted by Martin at 25%"), PERSISTS for a verification that persists (nothing reopens), and REOPENED for a reopening. PERSISTS ends a pass, and the next begins with the work's return to Plan; REOPENED begins one. The first pass and the pass holding the chosen chapter are drawn in full; every other pass is one chapter, PASS 2, drawn as a dashed square, which opens when chosen. When that still leaves too many chapters to keep a target's width apart, the first pass folds too. A work item with more than one pass has its chapters spread evenly; past twelve, only the chosen one, the first and the last keep their labels. Under the scrubber, the events up to the chosen chapter, the last five of them, with "All events (17)" to show the rest and "Fewer events" to fold them again.

## Not decided yet

- **Mark sign-off.** The MR monogram is a proposal until Martin approves it.
- **Social card and README header,** built from the mark once it is approved.
- **The audit log's table.**
- **Promote, hold and roll back on the Canary panel,** and the bottom row they come with (milestone 8).
