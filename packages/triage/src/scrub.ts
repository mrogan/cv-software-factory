/**
 * What leaves the cluster of a report's text: everything but email addresses and long numbers, which may be a
 * visitor's own details and are never needed to judge a report about a page.
 */
const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[a-z]{2,}/gi;
/** Six digits or more, allowing the spaces and dashes people type in phone and card numbers. */
const LONG_NUMBER = /\+?\d(?:[\s-]?\d){5,}/g;

export function scrub(text: string): string {
  return text.replace(EMAIL, '[email]').replace(LONG_NUMBER, '[number]');
}

/** The page a report names, without its query or fragment: those are typed by the visitor, so they are theirs. */
export const pathOf = (page: string) => page.split(/[?#]/)[0] || '/';
