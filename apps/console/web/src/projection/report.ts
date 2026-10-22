/**
 * A visitor's report, as Martin reads it on the sheet (spec 5.3): at most 140 characters of plain ASCII letters,
 * digits and basic punctuation, with links, email addresses and long numbers removed. The console inserts it as text,
 * never as markup. Only the full events carry a report's text, so only Martin's view has any to show.
 *
 * What a visitor wrote is untrusted: this keeps it short and plain enough to read at a glance, and leaves out what could
 * send Martin somewhere (a link), reach someone (an address) or carry something private (a card or phone number).
 */

/** The most of a report's text the console shows. */
export const REPORT_CHARS = 140;

/** Everything else is left out: no markup characters, no `@`, nothing outside ASCII. */
const NOT_ALLOWED = /[^A-Za-z0-9 .,!?'"():;/-]/g;

/** A scheme and what follows it, `www.` and what follows it, or anything shaped like a domain, with its path. */
const LINK = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S*|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/\S*)?/gi;
const EMAIL = /\S+@\S+/g;
/** Five digits or more, in one run or with single spaces, dots or dashes between them: a card, a phone, an account. */
const LONG_NUMBER = /\d(?:[ .-]?\d){4,}/g;

/** Curly quotes and dashes, which a phone's keyboard types, as their plain forms rather than left out. */
const PLAIN: [RegExp, string][] = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
];

const removeAll = (text: string) => text.replace(EMAIL, ' ').replace(LINK, ' ').replace(LONG_NUMBER, ' ');

/**
 * The report's text as Martin sees it, or undefined when nothing of it is left. Removing one thing can join what was
 * either side into another (`evil.<i>com`), so it removes until nothing changes.
 */
export function reportText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  // Accents come off their letters (é is e), and full-width and other compatibility forms become plain ASCII.
  let out = PLAIN.reduce((s, [pattern, plain]) => s.replace(pattern, plain), text.normalize('NFKD'));
  for (let before = ''; before !== out; ) {
    before = out;
    out = removeAll(out).replace(/\s+/g, ' ').replace(NOT_ALLOWED, '').replace(/ {2,}/g, ' ');
  }
  out = out.trim();
  if (!/[A-Za-z0-9]/.test(out)) return undefined;
  if (out.length <= REPORT_CHARS) return out;
  // Cut at a word, where there is one late enough, and say it was cut.
  const cut = out.slice(0, REPORT_CHARS - 3);
  const space = cut.lastIndexOf(' ');
  return `${(space > REPORT_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}...`;
}
