# 0007: The console is written in React, run by Preact, and built by Vite

## Decision

The console's browser code is written to React 19's API with TypeScript (TSX), and runs on Preact 11 through `preact/compat`: Vite aliases `react` to it, and the type checker reads Preact's types the same way. Vite 8 builds it as a plain single-page app: one page, no Next.js, no router, no server rendering. The Node server keeps running TypeScript directly, with no build. It serves the built files, the events and the artifacts.

The station stays a custom element, used from JSX as it is. The projection, `project(events, t)`, is plain TypeScript with no components in it, so it runs in Node tests as well as in the browser.

## Why

- **The build exists anyway.** The replay site on GitHub Pages serves files as they are, so the browser code has to become JavaScript before it publishes, whatever draws it. Vite is already in the lockfile through Vitest, with its native binaries, and none of its packages runs an install script. Preact and its Fast Refresh plugin add ten packages, none with an install script.
- **It keeps the content security policy strict.** A production build ran under the console's policy with no violations and no exceptions. Lit without a bundler, the other candidate for running unbuilt, needs its inline import map allowed by hash, and its `styleMap` was blocked on first render.
- **The type checker sees everything.** `tsc` 7 checks TSX with `erasableSyntaxOnly` on, markup included, and Biome lints it fully, accessibility rules included. Lit's and htm's templates are strings that neither tool reads. Svelte needs `svelte-check`, which today needs TypeScript 6 installed beside 7, and Biome's Svelte support is experimental.
- **Its model is ADR 0002's.** A React component is a function from state to view, and the console is a function from events to view.
- **Agents write it reliably.** Agents write most of this code and people review it. React is the UI library agents have seen most, and the code is React's: Preact only runs it.
- **Preact runs it in half the JavaScript.** Each new view needed the console's budget raised, and React and react-dom were nearly half of it. With Preact in their place, the console's gzipped JavaScript went from 129.6 kB to 69.2 kB. A trial (#236) ran the console's browser tests against the swap, visual snapshots and render counts included, and they passed unchanged; on a throttled phone the first view came 0.6 s sooner.

Svelte 5 came closest. Its transitions and springs suit the console's motion. It is worth another look once `svelte-check` runs on TypeScript 7 alone.

## Consequences

- "No build step" holds for the server, not the browser. The image gains a build stage that runs `vite build`, and the runtime image copies the output and production dependencies only.
- Built files are named by a hash of their contents and cached for a year. The page itself is never cached.
- The content security policy gains `script-src 'self'` and `connect-src 'self'`, and nothing else. Vite's dev server injects styles and Fast Refresh (Prefresh, Preact's) injects an inline script, so development runs a looser policy, and tests run against the production build.
- Per-frame work stays out of rendering. Dragging the reel, the wipe and the sheet's motion use refs, `style.transform` and `element.animate()`, and commit to state when they settle. A drag that re-renders on every frame stutters on a phone; a test counts renders during a drag.
- No state library, router or CSS-in-JS library. Styles are plain CSS files built from the design system's tokens, because CSS-in-JS libraries insert `<style>` elements that the policy refuses.
- Compat is not all of React. `useDeferredValue` returns its value at once and `StrictMode` is a fragment, so the console defers the reel with an effect, and checks itself in development with `preact/debug`. A library that reaches into React's internals would not run; the console uses none, and one that needs them is a reason to look at this again.
