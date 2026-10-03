# 0007: The console is a React single-page app, built by Vite

## Decision

The console's browser code is written in React 19 with TypeScript (TSX), and built by Vite 8 as a plain single-page app: one page, no Next.js, no router, no server rendering. The Node server keeps running TypeScript directly, with no build. It serves the built files, the events and the artifacts.

The station stays a custom element, used from JSX as it is. The projection, `project(events, t)`, is plain TypeScript with no React in it, so it runs in Node tests as well as in the browser.

## Why

- **The build exists anyway.** The replay site on GitHub Pages serves files as they are, so the browser code has to become JavaScript before it publishes, whatever draws it. Vite is already in the lockfile through Vitest, with its native binaries, and none of its packages runs an install script. React adds seven packages.
- **It keeps the content security policy strict.** A production build ran under the console's policy with no violations and no exceptions. Lit without a bundler, the other candidate for running unbuilt, needs its inline import map allowed by hash, and its `styleMap` was blocked on first render.
- **The type checker sees everything.** `tsc` 7 checks TSX with `erasableSyntaxOnly` on, markup included, and Biome lints it fully, accessibility rules included. Lit's and htm's templates are strings that neither tool reads. Svelte needs `svelte-check`, which today needs TypeScript 6 installed beside 7, and Biome's Svelte support is experimental.
- **Its model is ADR 0002's.** A React component is a function from state to view, and the console is a function from events to view.
- **Agents write it reliably.** Agents write most of this code and people review it. React is the UI library agents have seen most.

Svelte 5 came closest. Its transitions and springs suit the console's motion, and its runtime is a fifth of React's size. It is worth another look once `svelte-check` runs on TypeScript 7 alone.

## Consequences

- "No build step" holds for the server, not the browser. The image gains a build stage that runs `vite build`, and the runtime image copies the output and production dependencies only.
- Built files are named by a hash of their contents and cached for a year. The page itself is never cached.
- The content security policy gains `script-src 'self'` and `connect-src 'self'`, and nothing else. Vite's dev server injects styles and React's Fast Refresh injects an inline script, so development runs a looser policy, and tests run against the production build.
- Per-frame work stays out of React. Dragging the reel, the wipe and the sheet's motion use refs, `style.transform` and `element.animate()`, and commit to React state when they settle. A drag that re-renders on every frame stutters on a phone; a test counts renders during a drag.
- No state library, router or CSS-in-JS library. Styles are plain CSS files built from the design system's tokens, because CSS-in-JS libraries insert `<style>` elements that the policy refuses.
