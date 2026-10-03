/**
 * What leaves the cluster of a report's text: everything but email addresses and long numbers, which may be a
 * visitor's own details and are never needed to judge a report about a page.
 *
 * The text is a stranger's, so nothing here may take longer than a pass over it: emails are found word by word,
 * not by a pattern that could backtrack across the whole text.
 */
/** Six digits or more, allowing the spaces and dashes people type in phone and card numbers. */
const LONG_NUMBER = /\+?\d(?:[\s-]?\d){5,}/g;
/** A date is a fact about the page, which a content report may be about, not a visitor's detail. */
const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})$/;
/** What may wrap an address in prose: brackets, quotes and the punctuation after it. */
const WRAPPING = new Set('<>()[]"\'“”‘’,;:.!?');

export function scrub(text: string): string {
  return text
    .split(/(\s+)/)
    .map(withoutEmail)
    .join('')
    .replace(LONG_NUMBER, (found) => (DATE.test(found) ? found : '[number]'));
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

/**
 * The page a report names, as triage may use it: without its query, and with any email address or long number in
 * its path taken out, because a visitor can type a path too (a page that does not exist, say). Never longer than a
 * route may be.
 */
export function privatePath(page: string): string {
  const segments = pathOf(page)
    .split('/')
    .map((segment) => {
      let decoded = segment;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        // Not valid percent-encoding: judged as it is.
      }
      const scrubbed = scrub(decoded);
      return scrubbed === decoded ? segment : scrubbed.replace(/\s+/g, '-');
    });
  return segments.join('/').slice(0, 200);
}

/** A page or route short enough for a title or a summary: a long one keeps its start, and says it was cut. */
export const shortPath = (path: string, max = 60) => (path.length <= max ? path : `${path.slice(0, max - 1)}…`);
