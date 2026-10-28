/**
 * Text cut to fit what an event, a title or a summary holds: the factory's one way to cut, so none splits a
 * character a string holds as two UTF-16 units (an emoji), which the store refuses as JSON and a page shows as a
 * broken glyph.
 */

/**
 * `text` at most `max` characters long: as it is when it fits, or its start ending in `…`, the mark counted, cut
 * between characters and never inside one.
 */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = text.slice(0, Math.max(0, max - 1));
  return `${/[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept}…`;
}
