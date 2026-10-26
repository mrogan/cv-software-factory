/**
 * Properties of what leaves the cluster of a visitor's report (`src/scrub.ts`), over text fast-check makes up.
 * `routing.test.ts` holds the examples; these hold what must be true of any text, since a stranger writes it.
 *
 * What counts as an email address or a long number is the code's own rule, not RFC 5322: an address is a local part
 * of letters, digits and the punctuation an address allows, an `@`, and a domain of labels whose last begins with
 * two letters; a long number is six digits or more with at most one space or dash between each, unless it is shaped
 * like a date.
 *
 * A failure prints the seed and the shrunk text that broke the property: `fc.assert(..., { seed, path })` replays it.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { privatePath, scrub } from '../src/scrub.ts';

const chars = (set: string) => fc.constantFrom(...set);
const lower = 'abcdefghijklmnopqrstuvwxyz';
const alnum = `${lower}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`;

/** Letters from other scripts, which an address may hold and prose around it often does. */
const unicodeLetters = 'éüßøñçжйдзαβλ東京連絡先𝐡𝐚𠀋';

/**
 * An address as people write them: dotted, tagged, hyphenated, in any case, with a long or a country TLD, and now and
 * then a quoted local part with a space in it.
 */
const email = fc
  .record({
    first: chars(alnum + unicodeLetters),
    local: fc.string({ unit: chars(`${alnum}${unicodeLetters}!#$%&'*+/=?^_\`{|}~.-`), maxLength: 12 }),
    labels: fc.array(
      fc
        .tuple(chars(alnum), fc.string({ unit: chars(`${alnum}${unicodeLetters}-`), maxLength: 8 }), chars(alnum))
        .map(([a, b, c]) => a + b + c),
      { minLength: 1, maxLength: 3 },
    ),
    tld: fc.string({ unit: chars(lower + lower.toUpperCase()), minLength: 2, maxLength: 6 }),
    quote: fc.boolean(),
  })
  .map(({ first, local, labels, tld, quote }) => ({
    local: quote ? `"${first} ${local}"` : first + local,
    domain: [...labels, tld].join('.'),
  }))
  .map(({ local, domain }) => ({ local, domain, address: `${local}@${domain}` }));

/** What may sit right after an address in prose or markup: a dash may run on into the next address. */
const after = fc.oneof(
  fc.constantFrom('-', ' ', '\n', '\t', ' ', ',', ';', ':', '.', '!', '?', ')', ']', '>', '"', "'", '’', '”'),
  fc.constantFrom('*', '**', '_', '~', '`', '|', '/', '\\', '—', '–', '…', '。', '，', '🙂', '.\n', "'s", '),'),
);

/** Anything at all, in any script, `@` and digits included: the properties below allow for what it holds. */
const prose = fc.string({ unit: 'grapheme', maxLength: 20 });

/**
 * Text with addresses in it, each followed by something that ends it, and anything at all before it, or
 * nothing, so that addresses often run together with only a full stop or a comma between.
 */
const textWithEmails = fc
  .array(fc.tuple(fc.oneof(fc.constant(''), prose), email, after), { minLength: 1, maxLength: 4 })
  .map((parts) => ({
    emails: parts.map(([, found]) => found),
    text: parts.map(([before, found, end]) => before + found.address + end).join(''),
  }));

const count = (text: string, char: string) => text.split(char).length - 1;
const digits = (text: string) => text.replace(/\D/g, '').length;

describe('what leaves the cluster of a report, whatever the text', () => {
  it('has none of the email addresses in it, however each is wrapped and whatever follows it', () => {
    fc.assert(
      fc.property(textWithEmails, ({ text, emails }) => {
        const scrubbed = scrub(text);
        for (const { address, domain } of emails) {
          expect(scrubbed).not.toContain(address);
          expect(scrubbed).not.toContain(`@${domain}`);
        }
        // Each address takes its `@` with it, so neither half is left behind.
        expect(count(scrubbed, '@')).toBeLessThanOrEqual(count(text, '@') - emails.length);
      }),
    );
  });

  /** Six digits or more, grouped as people type phone and card numbers, and never shaped like a date. */
  const longNumber = fc
    .record({
      plus: fc.boolean(),
      groups: fc.array(fc.string({ unit: chars('0123456789'), minLength: 1, maxLength: 5 }), {
        minLength: 1,
        maxLength: 6,
      }),
      separators: fc.array(chars(' -\n\t '), { minLength: 6, maxLength: 6 }),
    })
    .map(({ plus, groups, separators }) => ({
      plus,
      number: groups.reduce((so, group, i) => (i === 0 ? group : so + separators[i] + group), ''),
    }))
    .filter(({ number }) => digits(number) >= 6 && !/^(?:\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{4})$/.test(number))
    .map(({ plus, number }) => (plus ? `+${number}` : number));

  /** What a number may sit beside without joining on to another: no digit, space or dash at its edge. */
  const edge = fc.oneof(
    fc.constant(''),
    fc.string({ unit: 'grapheme', maxLength: 12 }).filter((s) => !/[\d\s-]$/.test(s) && !/^[\d\s-]/.test(s)),
  );

  it('has none of the long numbers in it, whatever they sit beside', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(edge, longNumber), { minLength: 1, maxLength: 4 }), edge, (parts, last) => {
        const text = parts.map(([before, number]) => before + number).join('') + last;
        const scrubbed = scrub(text);
        for (const [, number] of parts) expect(scrubbed).not.toContain(number);
        expect(digits(scrubbed)).toBeLessThanOrEqual(digits(text) - parts.reduce((n, [, x]) => n + digits(x), 0));
      }),
    );
  });

  /**
   * Text with neither: words in any script with no digit or `@`, short numbers and prices, dates, social handles and
   * hosts without a domain, each kept apart by something that is not a space, a dash or a digit.
   */
  const plain = fc
    .array(
      fc.oneof(
        { weight: 4, arbitrary: fc.string({ unit: 'grapheme', maxLength: 16 }).map((s) => s.replace(/[\d@]/g, '')) },
        { weight: 2, arbitrary: fc.string({ unit: chars('0123456789'), minLength: 1, maxLength: 5 }) },
        { weight: 1, arbitrary: fc.constantFrom('£-12.99', '2026-10-03', '03-10-2026', '1.2.3', '99.5%') },
        { weight: 1, arbitrary: fc.constantFrom('@mossops', 'a@b', 'me@localhost', 'v@1.2.3', 'x@y.z', '@') },
      ),
      { maxLength: 12 },
    )
    .chain((tokens) =>
      fc
        .array(chars(',.;:!?()/"\'🙂'), { minLength: tokens.length, maxLength: tokens.length })
        .map((between) => tokens.map((token, i) => ` ${between[i]}${token}${between[i]} `).join('')),
    );

  it('is the text exactly as it was when it has neither', () => {
    fc.assert(
      fc.property(plain, (text) => {
        expect(scrub(text)).toBe(text);
      }),
    );
  });

  /** Anything at all: addresses, numbers, near misses and prose run together in any order. */
  const anything = fc
    .array(
      fc.oneof(
        prose,
        email.map((found) => found.address),
        fc.string({ unit: chars('0123456789 -.@+'), maxLength: 12 }),
        fc.string({ unit: chars(`${alnum}@.-'[]`), maxLength: 12 }),
        after,
      ),
      { maxLength: 10 },
    )
    .map((parts) => parts.join(''));

  it('is the same scrubbed again: nothing it puts in is taken for something else', () => {
    fc.assert(
      fc.property(anything, (text) => {
        const once = scrub(text);
        expect(scrub(once)).toBe(once);
      }),
    );
  });
});

/** The least time of a few, so one pause for garbage collection does not count as the code's. */
function timeOf(text: string): number {
  let least = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const started = performance.now();
    scrub(text);
    least = Math.min(least, performance.now() - started);
  }
  return least;
}

describe('the time scrubbing takes', () => {
  /**
   * A hostile text is a short piece of what the scanning turns on (`@`, dots, digits, separators, the letters of an
   * address) repeated. Eight times the length must take about eight times as long: a pass that went back over the
   * text would take sixty-four. The bound is three times the linear one, with a millisecond for the clock, so a busy
   * runner does not fail it and a quadratic pass still does.
   */
  const unit = fc.string({ unit: chars("@.a1 -!'(:x\n"), minLength: 1, maxLength: 8 });

  it('grows with the length of the text, however hostile', () => {
    fc.assert(
      fc.property(unit, (piece) => {
        const short = piece.repeat(Math.ceil(8_000 / piece.length));
        const long = short.repeat(8);
        expect(timeOf(long)).toBeLessThan(24 * timeOf(short) + 1);
      }),
    );
  });
});

describe('the page a report names, as triage may use it, whatever the page', () => {
  /** Each character of an address either as it is or percent-encoded, as a browser or a visitor may write it. */
  const encoded = (text: string) =>
    fc
      .array(fc.boolean(), { minLength: text.length, maxLength: text.length })
      .map((which) =>
        [...text]
          .map((c, i) =>
            which[i]
              ? encodeURIComponent(c).replace(/^[^%]/, (x) => `%${x.charCodeAt(0).toString(16).padStart(2, '0')}`)
              : c,
          )
          .join(''),
      );

  /**
   * A segment's text around an address: anything a path may hold, malformed escapes too, but no `/`, `?` or `#`, and
   * never a `%` that the address's first characters would complete as an escape, which would change the address.
   */
  const around = fc
    .oneof(
      fc.constant(''),
      fc.string({ unit: 'grapheme', maxLength: 10 }).map((s) => s.replace(/[/?#\d@]/g, '')),
      fc.constantFrom('%', '%ZZ', '%E0%A4', '%FF', '%2', '-', '~'),
    )
    .map((s) => s.replace(/%[0-9a-f]?$/i, ''));

  const segmentWithEmail = fc
    .tuple(
      around,
      // A `%` in an address is another address once a path is decoded, and `/`, `?` or `#` ends the segment.
      email.filter((found) => !/[%/?#]/.test(found.address)),
      after.filter((s) => !/[/?#]/.test(s)),
      around,
    )
    .chain(([before, found, end, rest]) =>
      encoded(found.address).map((written) => ({ found, segment: before + written + end + rest })),
    );

  const query = fc.string({ maxLength: 12 }).map((s) => s.replace(/[\d@]/g, ''));

  /**
   * The path as a browser would show it, written from the rule rather than the code: every escape a byte, every other
   * character its UTF-8, and bytes that are not UTF-8 shown as a replacement character, so what is valid still reads.
   */
  const readable = (path: string) => {
    const bytes: number[] = [];
    for (let i = 0; i < path.length; ) {
      const isEscape = /^%[0-9a-f]{2}/i.test(path.slice(i, i + 3));
      if (isEscape) {
        bytes.push(Number.parseInt(path.slice(i + 1, i + 3), 16));
        i += 3;
      } else {
        const char = String.fromCodePoint(path.codePointAt(i) ?? 0);
        bytes.push(...new TextEncoder().encode(char));
        i += char.length;
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  };

  it('has no email address in any segment, however it is encoded, and none of the query or fragment', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: chars(`${lower}-`), maxLength: 8 }), { maxLength: 3 }),
        segmentWithEmail,
        fc.constantFrom('?', '#'),
        query,
        (before, { found, segment }, mark, typed) => {
          const page = `/${[...before, segment].join('/')}${mark}${typed}`;
          const path = privatePath(page);
          expect(readable(path)).not.toContain(found.address);
          expect(readable(path)).not.toContain(`@${found.domain}`);
          expect(path).not.toContain(mark);
          expect(path.length).toBeLessThanOrEqual(200);
        },
      ),
    );
  });

  it('is never longer than a route may be, and is the path itself when it has nothing private', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: chars(`${lower}-._~`), maxLength: 40 }), { maxLength: 12, size: 'max' }),
        (segments) => {
          const page = `/${segments.join('/')}`;
          const path = privatePath(page);
          expect(path.length).toBeLessThanOrEqual(200);
          expect(path).toBe(page.slice(0, 200));
        },
      ),
    );
  });

  it('is never longer than a route may be, whatever it is given', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 600, size: 'max' }), (page) => {
        expect(privatePath(page).length).toBeLessThanOrEqual(200);
      }),
    );
  });
});
