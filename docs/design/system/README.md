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

The pattern for "needs you" in cards is a 2px `attn` rule on the left edge (`radius-rule` on that side), not a filled box.

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
- **Elevation:** flat. The only shadow is `--shadow-popover`, for panels that float over the line.
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

## Mark

An **MR monogram**: Martin Rogan's initials in Instrument Serif, with the R set so that it shares the M's last stem, and a full stop in `attn`. The shared stem makes two letters read as one mark. The ember full stop is the same colour that means "a person should look" on the console, so it carries the system's idea into the signature.

- **On the page:** inline the SVG with `fill: currentColor` for the letters and `var(--attn)` for the full stop, so it follows the theme. Height 30px in the header and 18px in the footer, with a hairline rule between the mark and "Software Factory".
- **Files:** `mark/mark.svg` (Paper), `mark/mark-ink.svg` (Ink) and `mark/icon.svg`: the monogram in paper on the station-face dark square, for favicons and app icons. It reads down to 16px.
- **Beyond the console:** the same mark and ember full stop can sign the CV, the README and the social card, with "Martin Rogan." set in Instrument Serif.
- Letterforms are from Instrument Serif (SIL Open Font Licence), which allows its use in a logo.

## Layout

One page, three widths. The console is designed to be read from top to bottom: *is it running → what is happening → what does it need from me*.

| Width | The line | Work | Bottom row |
|---|---|---|---|
| ≥ 1180 | 8 stations in a row, scaled to fit; captions show state and one figure | List (320px) beside the replay | Canary, Needs you (or Try it yourself), Controls |
| 721–1179 | Same row, smaller; captions show state only | List above the replay, as a grid | Canary full width, then two columns |
| ≤ 720 | **Two rows of four stations**, reading left to right like text; the current return becomes one line of text underneath; tapping a station opens a bottom sheet | List, then the replay, stacked; scrubber shows dots and the current label only | One column |

The phone keeps the stations: they are the thing people remember, and at a quarter of the width the face, hatch and beacon still read. What goes on the phone is detail: figures, the parcels on the belt, and the return arcs.

## What the console shows, and what it left out

The console was pared back so each panel does one job:

- **Header:** mark, name, whether the line is running (with the autonomy level), and Stop the line. Autonomy is set in Controls.
- **Scoreboard:** three figures: found, verified fixed, median time to verified. Totals, false positives and a separate "fixed" count were cut: "fixed" and "verified" were too close to earn two places.
- **Captions under stations:** the name and one line: state word and one figure. Descriptions moved into the stage panel. Switches moved into Controls.
- **Work items:** grouped Needs you, In progress, Done. No filters: the list is short, and grouping answers the question the filters were for.
- **Needs you:** one card per work item (a spec and the planner's question on it are one decision). Requesting an improvement lives on the Plan station, not here.
- **Controls:** autonomy, three switches and two spend meters. Guardrails that can't be switched off are not drawn as switches; one line says so.
- **Removed:** the apps row with "Onboard your app" placeholders, the live-feed ticker (the stations and the replay already show what is happening), the always-on green feedback loop under the belt (now a return like any other), the sparklines, and duplicate help text.

## Not decided yet

- **Frontend framework.** The console is web only. The station stays a custom element, so it works whichever framework is chosen.
- **Mark sign-off.** The MR monogram is a proposal until Martin approves it.
- **Social card and README header,** built from the mark once it is approved.
- **Empty, loading and error states,** toasts, and the audit log's table.
