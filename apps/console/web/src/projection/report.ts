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

/**
 * A scheme and what follows it, `www.` and what follows it, an IP address, or anything shaped like a domain, with its
 * path. A file's name (`index.html`) is shaped like a domain too, and goes with them: a link that gets through costs
 * more than a word that doesn't.
 */
const LINK =
  /\b[a-z][a-z0-9+.-]*:\/\/\S*|\bwww\.\S*|\b\d{1,3}(?:\.\d{1,3}){3}\b(?::\d+)?(?:\/\S*)?|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/\S*)?/gi;
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

/** Removes until nothing changes: removing one thing can join what was either side into another (`evil.<i>com`). */
function clean(text: string): string {
  let out = text;
  for (let before = ''; before !== out; ) {
    before = out;
    out = removeAll(out).replace(/\s+/g, ' ').replace(NOT_ALLOWED, '').replace(/ {2,}/g, ' ');
  }
  return out.trim();
}

/** Each text as made plain, since the sheet is drawn again on every tick of the clock and the text never changes. */
const made = new Map<string, string | undefined>();

/** The report's text as Martin sees it, or undefined when nothing of it is left. */
export function reportText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if (made.has(text)) return made.get(text);
  // Accents come off their letters (é is e), and full-width and other compatibility forms become plain ASCII.
  let out = clean(PLAIN.reduce((s, [pattern, plain]) => s.replace(pattern, plain), text.normalize('NFKD')));
  if (out.length > REPORT_CHARS) {
    // Cut at a word, where there is one late enough, and cleaned again, since a cut can leave a shape the whole
    // didn't have (`example.c` of `example.c1`); then say it was cut.
    const cut = out.slice(0, REPORT_CHARS - 3);
    const space = cut.lastIndexOf(' ');
    out = `${clean(space > REPORT_CHARS / 2 ? cut.slice(0, space) : cut)}...`;
  }
  const shown = /[A-Za-z0-9]/.test(out) ? out : undefined;
  if (made.size > 500) made.clear();
  made.set(text, shown);
  return shown;
}
