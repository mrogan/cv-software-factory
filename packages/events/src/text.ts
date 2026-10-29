/**
 * Text cut to fit what an event, a title or a summary holds: the factory's one way to cut, so none splits a
 * character a string holds as two UTF-16 units (an emoji), which the store refuses as JSON and a page shows as a
 * broken glyph.
 */

/**
 * `text` at most `max` characters long: as it is when it fits, or its start ending in `…`, the mark counted, cut
 * between characters and never inside one. For words someone reads.
 */
export function cutTo(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${cutAt(text, Math.max(0, max - 1))}…`;
}

/**
 * `text`'s first `max` units, with no mark, less the first half of a character the cut would split. For text that
 * names something (a check, a passage a fingerprint holds, a line a pattern is made from): it is `text.slice(0, max)`
 * whenever the cut falls between characters, so a name cut before stays the same name.
 */
export function cutAt(text: string, max: number): string {
  const kept = text.slice(0, max);
  return kept.length < text.length && /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept;
}
