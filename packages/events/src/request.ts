/**
 * Martin's request for an improvement, as he types it in the console's "+": one field, his words. The work item's title
 * is made from them by a rule, not a model, until the planner names it in the spec (`spec.written`'s `title`). One copy,
 * here, so the console shows the title the admin service will give. Plain values, so the browser can import them.
 */

/** The most characters his words may run to, as the form counts them and the event keeps them. */
export const REQUEST_WORDS = 600;

/** The most characters a title made from his words runs to, its `…` included when it is cut. */
export const REQUEST_TITLE = 60;

/**
 * The title of the work item his words open: their first sentence, or their first line, with its spaces collapsed and a
 * closing full stop left off; cut at the last word, and marked with `…`, to `REQUEST_TITLE` characters with the mark
 * when it is longer. A sentence ends at `.`, `!` or `?` before a space and a capital letter, or before the end: so
 * "Add a U.S. flag" is one sentence, as is "Say v1.2 in the footer". A first sentence with nothing in it gives way to
 * the whole of his words.
 */
export function requestTitle(words: string): string {
  const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
  const text = words.trim();
  const end = /[.!?](?=\s+\p{Lu}|\s*$)|\n/u.exec(text);
  const first = end ? text.slice(0, end.index + (end[0] === '\n' ? 0 : 1)) : text;
  const sentence = collapse(first).replace(/\.$/, '');
  const title = sentence || collapse(words);
  if (title.length <= REQUEST_TITLE) return title;
  // Room for the mark: the cut is at most one character short of the whole.
  const within = title.slice(0, REQUEST_TITLE);
  const space = within.lastIndexOf(' ');
  const cut = space > 0 ? within.slice(0, space) : title.slice(0, REQUEST_TITLE - 1);
  return `${cut.replace(/[\s,;:–—-]+$/, '')}…`;
}
