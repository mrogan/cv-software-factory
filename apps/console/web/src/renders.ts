/**
 * How many times the reel has rendered. The drag test reads it (through `?debug=renders`) to prove that dragging
 * draws frames without rendering: the count must not grow with the number of frames.
 */
export const renders = { reel: 0 };

if (new URLSearchParams(location.search).get('debug') === 'renders') {
  (globalThis as { sfRenders?: typeof renders }).sfRenders = renders;
}
