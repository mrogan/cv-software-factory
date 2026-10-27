/**
 * What leaves the cluster of a report's text: everything but email addresses and long numbers, which may be a
 * visitor's own details and are never needed to judge a report about a page.
 *
 * The text is a stranger's, so nothing here may take longer than a pass over it: an address is found from its `@`,
 * looking back over its local part and on over its domain, and neither can hold an `@`, so each scan stops at the
 * next one and no character is looked at more than a few times; and the number pattern cannot backtrack.
 */
/** Six digits or more, allowing the spaces and dashes people type in phone and card numbers. */
const LONG_NUMBER = /\+?\d(?:[\s-]?\d){5,}/g;
/** A date is a fact about the page, which a content report may be about, not a visitor's detail. */
const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})$/;
/**
 * What an address's local part may be made of: letters and digits in any script, and the punctuation an address
 * allows there. Markup or a word glued on in front (`**`, `and/`) goes with it: taking too much is the safe side.
 */
const LOCAL = /[\p{L}\p{M}\p{N}\p{Cf}!#$%&'*+/=?^_`{|}~.-]/u;
/**
 * What a domain may be made of, `_` too. Whatever follows it in prose (a quote, a bracket, a dash, an emoji) ends it.
 * Both take in the invisible format characters (a zero-width space, a soft hyphen), which would otherwise split an
 * address that looks whole.
 */
const DOMAIN = /[\p{L}\p{M}\p{N}\p{Cf}._-]/u;
/**
 * A domain's last label begins with two letters: `example.com`, `example.co.uk`, not `1.2.3` or a host alone. An
 * invisible character among them does not count, as the reader does not see it.
 */
const TOP_LABEL = /^\p{Cf}*\p{L}\p{Cf}*\p{L}/u;
/** Letters and digits in any script, which an address and its domain begin with. */
const ALPHANUMERIC = /[\p{L}\p{N}]/u;

export function scrub(text: string): string {
  return withoutEmails(text).replace(LONG_NUMBER, (found) => (DATE.test(found) ? found : '[number]'));
}

/**
 * The text with each email address in it replaced, wherever it sits: wrapped in brackets, quotes or markup, followed
 * by punctuation or a possessive, or next to another address with no space between.
 */
function withoutEmails(text: string): string {
  let out = '';
  let done = 0;
  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', at + 1)) {
    const start = quoted(text, at, done) ?? forward(text, back(text, at, done, LOCAL), at, ALPHANUMERIC, true);
    const end = forward(text, at + 1, text.length, DOMAIN);
    const next = forward(text, end, text.length, LOCAL);
    const length = domainIn(text.slice(at + 1, end), text.charAt(next) === '@');
    if (length === 0) continue;
    // Where the address before ran on into this one's local part (`a@x.comb@y.com`), its `[email]` covers this too.
    const runOn = done > 0 && at === done;
    if (start === at && !runOn) continue;
    if (!runOn) out += `${text.slice(done, start)}[email]`;
    done = at + 1 + length;
    at = done - 1;
  }
  return out + text.slice(done);
}

/**
 * How much of what follows an `@` is a domain, or 0 if none is: the longest run of labels, from the first, whose last
 * begins with two letters. What is left after it (a full stop, a dash, an underscore, `.5`) is not the address's. Where the run goes
 * on into another address's local part with no space between, what follows its last `.`, `-` or `_` begins that local
 * part, and is left to it if what comes before is a domain.
 */
function domainIn(run: string, beforeAnother: boolean): number {
  // It begins with a letter or a digit, after any invisible character.
  const first = forward(run, 0, run.length, /\p{Cf}/u);
  if (first === run.length || !ALPHANUMERIC.test(String.fromCodePoint(run.codePointAt(first) ?? 0))) return 0;
  if (!beforeAnother) return longestDomain(run, run.length);
  // Where its last letter or digit ends: the run begins with one, so there is one.
  let last = run.length;
  while (!ALPHANUMERIC.test(charBefore(run, last))) last -= charBefore(run, last).length;
  const cut = Math.max(...[...'.-_'].map((mark) => run.lastIndexOf(mark, last - 1)));
  return longestDomain(run, cut) || longestDomain(run, run.length);
}

/** The length of the longest domain at the start of a run, up to `cut`, or 0. */
function longestDomain(run: string, cut: number): number {
  let end = cut;
  while (end > 0 && '.-_'.includes(run.charAt(end - 1))) end--;
  for (let dot = run.lastIndexOf('.', end - 1); dot > 0; dot = run.lastIndexOf('.', end - 1)) {
    if (TOP_LABEL.test(run.slice(dot + 1, end))) return end;
    end = dot;
  }
  return 0;
}

/**
 * Where a quoted local part (`"jo bloggs"@example.com`) begins, if the `@` follows one: at its opening quote, which
 * is the one before its closing quote, so scans for two addresses never cross. Not before `done`.
 */
function quoted(text: string, at: number, done: number): number | undefined {
  if (text.charAt(at - 1) !== '"') return undefined;
  const open = text.lastIndexOf('"', at - 2);
  return open >= done && at - open > 2 ? open : undefined;
}

/**
 * Where a scan forward from `from` stops: at the first character that is not of `kind` (or, with `until`, the first
 * that is), or at `to`. A character is a code point, so a letter outside the Basic Multilingual Plane is one letter.
 */
function forward(text: string, from: number, to: number, kind: RegExp, until = false): number {
  let i = from;
  while (i < to) {
    const char = String.fromCodePoint(text.codePointAt(i) ?? 0);
    if (kind.test(char) === until) break;
    i += char.length;
  }
  return i;
}

/** Where a scan back from `from` over characters of `kind` stops, never before `to`. */
function back(text: string, from: number, to: number, kind: RegExp): number {
  let i = from;
  while (i > to && kind.test(charBefore(text, i))) i -= charBefore(text, i).length;
  return i;
}

/** The code point that ends just before `i`: both halves of a surrogate pair, or one character. */
function charBefore(text: string, i: number): string {
  const pair = text.slice(Math.max(i - 2, 0), i);
  return pair.length === 2 && String.fromCodePoint(pair.codePointAt(0) ?? 0) === pair ? pair : text.charAt(i - 1);
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
      const decoded = readable(segment);
      const scrubbed = scrub(decoded);
      return scrubbed === decoded ? segment : scrubbed.replace(/\s+/g, '-');
    });
  return segments.join('/').slice(0, 200);
}

/**
 * A segment as a browser would show it. Where its escapes are not all UTF-8, each run of them is read as bytes and the
 * ones that are not UTF-8 shown as a replacement character, so a stray `%ZZ` or a lone byte beside an address cannot
 * hide the `%40` in it, or keep the rest of its domain encoded.
 */
function readable(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment.replace(/(?:%[0-9a-f]{2})+/gi, (run) =>
      UTF8.decode(Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16))),
    );
  }
}

const UTF8 = new TextDecoder();

/** A page or route short enough for a title or a summary: a long one keeps its start, and says it was cut. */
export const shortPath = (path: string, max = 60) => (path.length <= max ? path : `${path.slice(0, max - 1)}…`);
