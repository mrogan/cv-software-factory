# Paper & Ink: the Software Factory design system

The console's visual language: colour roles, type, spacing and the station kit. Version 0.1: enough to build the console skeleton and the line; the gaps are listed at the end.

Open [`index.html`](index.html) to see it: every token, both themes, the mark, and every station in every state. The console mockup built from it is [`../mockups/console.html`](../mockups/console.html): plain HTML, CSS and JS, and the reference for `apps/console`.

## Files

| File | What it is | Edit? |
|---|---|---|
| [`tokens.json`](tokens.json) | Source of truth: colour roles per theme, type, space, radius, stroke, shadow, motion, station geometry. W3C Design Tokens (DTCG) format. | Yes |
| [`tokens.css`](tokens.css) | Custom properties and `.t-*` type classes, generated from the JSON. | No: run `build.ts` |
| [`build.ts`](build.ts) | `node docs/design/system/build.ts` (Node 24, no dependencies) regenerates `tokens.css` and fails if any meaningful colour pair drops below WCAG 2.2 AA. With `--check` it writes nothing and fails if `tokens.css` is out of date; `make check` runs it that way. | Yes |
| [`station.js`](station.js) | The `<sf-station>` element: reference implementation of the station kit. | Yes |
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
| `attn` (+ `on-attn`, `-wash`, `-line`) | Needs you, held, blocked, failed, rolled back, Stop the line | Decoration, links, brand |
| `station-face`, `station-led-*` | The station's LED face (always dark) and its glyphs | Anything outside a station |
| `station-canary` | The Release station's bird | Anything else |
| `scrim` | Dimming the page behind the sheet | Anything that carries meaning |

The pattern for "needs you" in cards is a 2px `attn` rule on the left edge (`radius-rule` on that side), not a filled box. The reel's cards are the exception: their outcome dot flashes instead.

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
| **Beacon** | Whether to look | dim | ink | ink | green glow | flashing ember, rays | flashing ember, rays, smoke |
| **Belt** | Flow | still | forward | backwards | forward, slower | still | still |
| **Caption word** | | idle | working | sending back | passed | needs you | failed |
| **Tone role** | | `text-faint` | `signal` | `signal` | `ok` | `attn` | `attn` |

Blocked and failed share `attn` on purpose: both mean a person should act. Their hatch, face and smoke tell them apart.

### From events to a station's status

A proposal for the console's projection of the event store; confirm it when the event schema lands (milestone 3). Evaluate each stage's current work items and take the first rule that matches:

1. **failed:** an item in the stage has failed and has not been retried or rolled back.
2. **blocked:** an item is waiting on a human (spec approval, held PR, planner question, Stop the line).
3. **returning:** an item was sent upstream from this stage in the last few minutes.
4. **working:** at least one item is in progress.
5. **passing:** the most recent item left the stage successfully, and nothing is in progress.
6. **idle:** otherwise.

Under Stop the line, every station shows `blocked` and the belt stops.

### On the line

- Stations sit edge to edge; the rollers at each seam hide the belt joints.
- Parcels (14 × 12, `surface` fill, `text` stroke) ride on the belt top (`--station-belt-top`, 186px) and pile up in front of a station that needs you. They are decorative; the counts live in the captions and the stage panel.
- **Returns** are drawn as a dashed `signal` arc over the stations, from the sender back to the receiver, with a one-line label in a small pill (return icon, `t-data`). There are two kinds: a stage sending work back (Review → Build, Gates → Build), and Verify feeding new tickets from production back to Sense.
- **One return at a time.** Returns queue newest first and show for about five seconds each, fading in and out. While its arc shows, the sender's station and caption switch to `returning`. With motion off, the newest return holds still. Under Stop the line, none show. Returns are fleeting, so each one is also written as a row in the sender's stage panel.
- **The whole station is the hit target** (a `<button>` wrapping station and caption). Hover lifts the machine 3px through `::part(machine)`; the legs and belt never move, so the line stays continuous. When the stage panel is open, the stage name gets a 2px underline.
- **Entry points sit on the stage they feed.** Admin sees a round `signal` + on Plan (request an improvement), repeated as a button in the Plan panel. Triage's panel lists what it takes work from; sources that aren't built for the demo (Slack, Linear or Jira) are shown with a dashed border and "not in the demo".
- Under each station: stage name (`t-stage`), a dot and the state word, then the stage's figures and controls. The word is always there, so colour is never the only signal.

### Porting it into the app

`station.js` is dependency-free and works in any framework that renders custom elements. It is a classic script (so design pages open from disk); in the app, port it to a TypeScript module or a framework component, and keep the drawing, the state table above and the reduced-motion rules. Worth a visual-regression snapshot per kind × state in both themes (96 images) and an axe check on the line.

## The reel and the sheet

Work items are shown as a **reel**: one card per work item, oldest on the left and now on the right, scrubbed sideways. Opening a card raises its **sheet** from the bottom of the screen, with everything about that work item.

### The reel

- **One card in the centre**, its neighbours either side at 90% scale and lower opacity, fading out at the reel's edges. Drag the cards, flick them, use the arrow keys, or drag the **timeline** underneath; release snaps to the nearest card. Clicking a neighbour brings it to the centre; clicking the centre card opens its sheet.
- **The timeline** has one mark per work item, in its category glyph and outcome tone, a hairline at the start of each day, the version each release left the shop on (a version rolled back is struck through), and a playhead. Under it, one line says when the centre card happened and what version the shop was then.
- **Play the history** steps a card every 2.5 seconds and ends at now. On first view the reel plays the most recent eight work items once, when it scrolls into view. With motion off it never plays itself, and the cards move without animating.
- **Needs you** cards (waiting on Martin, or held for a human) flash their outcome dot at `--motion-alarm`, like a station's beacon, and hold it still with its ring when motion is off. They take no edge rule: the picture often carries one already.

### A card

Top to bottom, and nothing else:

1. **Category and kind** on the left (glyph, `t-label` caps, then the kind in `t-caption`); **outcome** on the right: dot and word, in the outcome's tone.
2. **The picture**, 16:10. See below.
3. **Title** in Instrument Serif 28, and a description clamped to two lines.
4. **One line of facts** in `t-data`: number, version (a pill), pull request, start, duration, model spend.
5. **Eight segments**, one per stage: `ok` for passed, a dashed outline for skipped, `signal` (blinking) for now, `attn` where it stopped or waits on a human, `text-muted` where triage closed it. The segments have an accessible label such as "Stopped at Release".

### The picture

The picture is evidence, so it is always something the factory captured, never an illustration.

| Work | Picture |
|---|---|
| A visible change | Screenshots before and after, with a **wipe** between them: a 2px `signal` divider and a round handle (drag it, or arrow keys on it). Each side is its own stacking context, so nothing drawn on one side shows through the other. Tags in the bottom corners name each side (BEFORE, BROKEN, FIXED, NOW) with its version. |
| Performance | The metric over time, one series, with the objective dashed and the release marked; the headline before → after above it; a strip of page thumbnails saying no page changed |
| Dependency update | Package logo and the version change; the screenshot strip below |
| Security | Package logo and version change, and the image scan's findings before and after by severity |
| Rollback | Canary against baseline on one axis, the rollback marked; a line saying how much traffic never saw it |
| Red-team attack | The gate's or policy's own refusal, verbatim, on the station face colour; "the site never changed" |
| Not a defect | The page the report was about, and Jev's typed answers with their probabilities |
| Observability | Log lines before and after, and the trace they now link to |
| Waiting on Martin | The spec: outcome, acceptance criteria and the planner's question, with the `attn` rule |

**Marks** on a screenshot are drawn by the factory from the elements its probe checked: a dashed `attn` outline for the problem and a solid `ok` outline for the fix, or for the page as it should be, each with a short label in a filled tag. Both sides of a wipe carry a mark, and never more than one label per side.

Package logos come from [theSVG](https://github.com/glincker/thesvg) (MIT; the marks belong to their owners) and are bundled with the console, never fetched.

### The sheet

- Rises from the bottom to 90% of the viewport height (94% on a phone) over a `scrim`, with `--shadow-popover` and 14px top corners. Escape, the close button or the scrim close it, and focus returns to where it was. Previous and next step between work items, and the reel follows behind.
- **Main column:** a paragraph saying what happened; for a visitor's report, the report (below); **How it went**, the stage scrubber with the site's screenshot at each step; **Evidence**, the picture at full size, the screenshots captured at signal, canary and rollout, and every page compared with the version before; **The change**, acceptance criteria and the files touched.
- **Side column:** the facts (including "Code written by humans: 0 lines"), **Agents and models** (each agent's model, settings, calls, tokens and cost, with a total), and **Gates** (each check, its result and time).
- Each evidence block ends with a one-line **Source**: where the factory got it.

### A visitor's report

Report text is untrusted. The console shows it only to Martin and to the visitor whose key sent it, sanitised to at most 140 characters of plain ASCII letters, digits and basic punctuation, with links, email addresses and long numbers removed, and inserted as a text node, never as markup. Everyone else sees that a report was made, and what triage made of it.

## Mark

An **MR monogram**: Martin Rogan's initials in Instrument Serif, with the R set so that it shares the M's last stem, and a full stop in `attn`. The shared stem makes two letters read as one mark. The ember full stop is the same colour that means "a person should look" on the console, so it carries the system's idea into the signature.

- **On the page:** inline the SVG with `fill: currentColor` for the letters and `var(--attn)` for the full stop, so it follows the theme. Height 30px in the header and 18px in the footer, with a hairline rule between the mark and "Software Factory".
- **Files:** `mark/mark.svg` (Paper), `mark/mark-ink.svg` (Ink) and `mark/icon.svg`: the monogram in paper on the station-face dark square, for favicons and app icons. It reads down to 16px.
- **Beyond the console:** the same mark and ember full stop can sign the CV, the README and the social card, with "Martin Rogan." set in Instrument Serif.
- Letterforms are from Instrument Serif (SIL Open Font Licence), which allows its use in a logo.

## Layout

One page, three widths. The console is designed to be read from top to bottom: *is it running → what is happening → what does it need from me*.

| Width | The line | The reel and the sheet | Bottom row |
|---|---|---|---|
| ≥ 1180 | 8 stations in a row, scaled to fit; captions show state and one figure | Cards up to 620px with both neighbours showing; the sheet in two columns | Canary, Needs you (or Try it yourself), Controls |
| 721–1179 | Same row, smaller; captions show state only | The same reel; the sheet in one column, its side column as two cards side by side | Canary full width, then two columns |
| ≤ 720 | **Two rows of four stations**, reading left to right like text; the current return becomes one line of text underneath; tapping a station opens a bottom sheet | Cards the width of the screen with neighbours just showing; the timeline shows only the current version; the sheet at 94% height, one column, its scrubber showing dots and the current label | One column |

The phone keeps the stations: they are the thing people remember, and at a quarter of the width the face, hatch and beacon still read. What goes on the phone is detail: figures, the parcels on the belt, and the return arcs.

## What the console shows, and what it leaves out

Each panel does one job:

- **Header:** mark, name, whether the line is running (with the autonomy level), and Stop the line. Autonomy is set in Controls.
- **Scoreboard:** three figures: found, verified fixed, median time to verified. No totals, false positives or separate "fixed" count: "fixed" and "verified" are too close to earn two places.
- **Captions under stations:** the name and one line: state word and one figure. Descriptions belong in the stage panel, switches in Controls.
- **The reel:** every work item, oldest to now. Watching the shop change says more than a list; what waits on Martin is also listed in Needs you.
- **The sheet:** one work item in full: the stage scrubber and the site at each step, the evidence, the change, the model calls and the gates.
- **Needs you:** one card per work item (a spec and the planner's question on it are one decision). Requesting an improvement lives on the Plan station, not here.
- **Controls:** autonomy, three switches and two spend meters. Guardrails that can't be switched off are not drawn as switches; one line says so.
- **Left out on purpose:** placeholders for other apps, a live-feed ticker (the stations and the reel already show what is happening), an always-on feedback loop under the belt (production feeding Sense is a return like any other), sparklines, and help text that repeats itself.

## Not decided yet

- **Frontend framework.** The console is web only. The station stays a custom element, so it works whichever framework is chosen.
- **Mark sign-off.** The MR monogram is a proposal until Martin approves it.
- **Social card and README header,** built from the mark once it is approved.
- **Empty, loading and error states,** toasts, and the audit log's table.
