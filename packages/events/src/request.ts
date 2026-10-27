/**
 * Martin's request for an improvement, as he types it in the console's "+": one field, his words. The work item's title
 * is made from them by a rule, not a model, until the planner names it in the spec (`spec.written`'s `title`). One copy,
 * here, so the console shows the title the admin service will give. Plain values, so the browser can import them.
 */

/** The most characters his words may run to, as the form counts them and the event keeps them. */
export const REQUEST_WORDS = 600;

/** About how long a title made from his words runs, before it is cut at a word. */
export const REQUEST_TITLE = 60;

/**
 * The title of the work item his words open: their first sentence, ending at `.`, `!` or `?` before a space or the
 * end, or at a line's end, with its spaces collapsed and a closing full stop left off; cut at the last word within
 * `REQUEST_TITLE` characters, and marked with `…`, when it is longer. A first sentence with nothing in it gives way to
 * the whole of his words.
 */
export function requestTitle(words: string): string {
  const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
  const first = /^(.*?[.!?])(?=\s|$)|^[^\n]*/s.exec(words.trim())?.[0] ?? '';
  const sentence = collapse(first.split('\n')[0] ?? '').replace(/\.$/, '');
  const title = sentence || collapse(words);
  if (title.length <= REQUEST_TITLE) return title;
  const within = title.slice(0, REQUEST_TITLE + 1);
  const space = within.lastIndexOf(' ');
  const cut = space > 0 ? within.slice(0, space) : title.slice(0, REQUEST_TITLE - 1);
  return `${cut.replace(/[\s,;:–—-]+$/, '')}…`;
}
