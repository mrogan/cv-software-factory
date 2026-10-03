/**
 * What leaves the cluster of a report's text: everything but email addresses and long numbers, which may be a
 * visitor's own details and are never needed to judge a report about a page.
 *
 * The text is a stranger's, so nothing here may take longer than a pass over it: emails are found word by word,
 * not by a pattern that could backtrack across the whole text.
 */
/** Six digits or more, allowing the spaces and dashes people type in phone and card numbers. */
const LONG_NUMBER = /\+?\d(?:[\s-]?\d){5,}/g;
/** What may wrap an address in prose: brackets, quotes and the punctuation after it. */
const WRAPPING = new Set('<>()[]"\'“”‘’,;:.!?');

export function scrub(text: string): string {
  return text.split(/(\s+)/).map(withoutEmail).join('').replace(LONG_NUMBER, '[number]');
}

/** A word with an email address in it, the address replaced and what wraps it kept. */
function withoutEmail(word: string): string {
  if (!word.includes('@')) return word;
  let start = 0;
  let end = word.length;
  while (start < end && WRAPPING.has(word.charAt(start))) start++;
  while (end > start && WRAPPING.has(word.charAt(end - 1))) end--;
  const core = word.slice(start, end);
  const at = core.indexOf('@');
  const dot = core.lastIndexOf('.');
  const tld = core.slice(dot + 1);
  const isEmail = at > 0 && at === core.lastIndexOf('@') && dot > at + 1 && tld.length >= 2 && /^[a-z]+$/i.test(tld);
  return isEmail ? `${word.slice(0, start)}[email]${word.slice(end)}` : word;
}

/** The page a report names, without its query or fragment: those are typed by the visitor, so they are theirs. */
export const pathOf = (page: string) => page.split(/[?#]/)[0] || '/';
